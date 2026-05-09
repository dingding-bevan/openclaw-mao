import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";
import { Worktree } from "./worktree.ts";
import { Notifier } from "./notifier.ts";

export interface MergeOptions {
  dryRun?: boolean;
  noCleanup?: boolean;
  workspaceRoot: string;
}

export interface MergeResult {
  ok: boolean;
  task_id: string;
  sub_status?: string;
  diff_stat?: string;
  commits?: string[];
  ci?: { ran: boolean; ok?: boolean; output?: string };
  merged?: boolean;
  cleaned?: boolean;
  error?: string;
}

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tryRunCi(worktreePath: string): { ran: boolean; ok?: boolean; output?: string } {
  if (!existsSync(`${worktreePath}/package.json`)) {
    return { ran: false };
  }
  // Best-effort: try `npm test` with short timeout. Plug-in/test repo agnostic.
  const r = spawnSync("npm", ["test"], { cwd: worktreePath, encoding: "utf8", timeout: 60_000 });
  return { ran: true, ok: r.status === 0, output: (r.stdout ?? "").slice(-2000) + (r.stderr ?? "").slice(-1000) };
}

export const Merger = {
  merge(api: OpenClawPluginApi, taskId: string, opts: MergeOptions): MergeResult {
    const row = Tracker.get(taskId);
    if (!row) return { ok: false, task_id: taskId, error: "task not found" };

    const allowedStates: TaskRow["sub_status"][] = ["completed", "pushed"];
    if (!allowedStates.includes(row.sub_status)) {
      return {
        ok: false,
        task_id: taskId,
        sub_status: row.sub_status,
        error: `task sub_status=${row.sub_status}, expected completed|pushed`,
      };
    }
    if (!row.branch) return { ok: false, task_id: taskId, error: "task has no branch" };
    if (!row.worktree_path || !existsSync(row.worktree_path)) {
      return { ok: false, task_id: taskId, error: "worktree missing or already cleaned up" };
    }

    // 1. Diff stat + commits (always reported)
    const baseRef = gitSync(row.worktree_path, ["rev-parse", "--verify", "origin/main"]).ok ? "origin/main" : "main";
    const diffStat = gitSync(row.worktree_path, ["diff", "--stat", `${baseRef}...HEAD`]).stdout.trim();
    const log = gitSync(row.worktree_path, ["log", `${baseRef}..HEAD`, "--oneline"]).stdout.trim();
    const commits = log ? log.split("\n") : [];

    if (opts.dryRun) {
      return {
        ok: true,
        task_id: taskId,
        sub_status: row.sub_status,
        diff_stat: diffStat,
        commits,
        merged: false,
      };
    }

    // 2. Best-effort CI
    const ci = tryRunCi(row.worktree_path);
    if (ci.ran && ci.ok === false) {
      return {
        ok: false,
        task_id: taskId,
        diff_stat: diffStat,
        commits,
        ci,
        error: "CI failed; aborting merge",
      };
    }

    // 3. Fast-forward merge into main on the workspace root, then push
    const fetch = gitSync(opts.workspaceRoot, ["fetch", "origin", "main"]);
    if (!fetch.ok) {
      return { ok: false, task_id: taskId, diff_stat: diffStat, commits, ci, error: `git fetch failed: ${fetch.stderr}` };
    }
    const checkout = gitSync(opts.workspaceRoot, ["checkout", "main"]);
    if (!checkout.ok) {
      return { ok: false, task_id: taskId, diff_stat: diffStat, commits, ci, error: `git checkout main failed: ${checkout.stderr}` };
    }
    const pull = gitSync(opts.workspaceRoot, ["pull", "--ff-only", "origin", "main"]);
    if (!pull.ok) {
      return { ok: false, task_id: taskId, diff_stat: diffStat, commits, ci, error: `git pull --ff-only failed: ${pull.stderr}` };
    }
    const merge = gitSync(opts.workspaceRoot, ["merge", "--ff-only", row.branch]);
    if (!merge.ok) {
      return { ok: false, task_id: taskId, diff_stat: diffStat, commits, ci, error: `git merge --ff-only failed: ${merge.stderr}` };
    }
    const push = gitSync(opts.workspaceRoot, ["push", "origin", "main"]);
    if (!push.ok) {
      return { ok: false, task_id: taskId, diff_stat: diffStat, commits, ci, error: `git push origin main failed: ${push.stderr}` };
    }

    // 4. Cleanup unless --no-cleanup
    let cleaned = false;
    if (!opts.noCleanup) {
      Worktree.remove(opts.workspaceRoot, row.assignee, row.task_id, row.branch);
      cleaned = true;
    }

    Notifier.sendDiscord(api, `✅ mao merge completed: ${taskId} (${row.type} → main, ${commits.length} commits)`);

    return {
      ok: true,
      task_id: taskId,
      sub_status: row.sub_status,
      diff_stat: diffStat,
      commits,
      ci,
      merged: true,
      cleaned,
    };
  },
};
