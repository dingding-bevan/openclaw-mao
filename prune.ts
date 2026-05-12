import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";
import { Worktree } from "./worktree.ts";

export interface PruneOpts {
  workspaceRoot: string;
  dryRun: boolean;
}

export interface PruneResult {
  ok: boolean;
  dry_run: boolean;
  orphan_worktrees: { dir: string; reason: string; removed?: boolean }[];
  orphan_branches: { branch: string; reason: string; removed?: boolean }[];
}

const TERMINAL: TaskRow["sub_status"][] = ["completed", "failed", "cancelled"];

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function parseWorktreeDir(name: string): { agent: string; taskId: string } | null {
  // form: <agent>-<task-id>, where task-id is "task-<digits>-<suffix>"
  const m = name.match(/^([^-]+(?:-[^-]+)*?)-(task-\d+-[a-z0-9]+)$/);
  if (!m) return null;
  return { agent: m[1], taskId: m[2] };
}

export const Pruner = {
  prune(api: OpenClawPluginApi, opts: PruneOpts): PruneResult {
    const out: PruneResult = { ok: true, dry_run: opts.dryRun, orphan_worktrees: [], orphan_branches: [] };

    // 1. Scan worktrees/ directory
    const worktreesDir = `${opts.workspaceRoot}/worktrees`;
    if (existsSync(worktreesDir)) {
      for (const dir of readdirSync(worktreesDir)) {
        const parsed = parseWorktreeDir(dir);
        if (!parsed) {
          out.orphan_worktrees.push({ dir, reason: "name does not match <agent>-<task-id>" });
          continue;
        }
        const row = Tracker.get(parsed.taskId);
        if (!row) {
          out.orphan_worktrees.push({ dir, reason: "no sqlite row for task" });
          continue;
        }
        if (TERMINAL.includes(row.sub_status)) {
          out.orphan_worktrees.push({ dir, reason: `task is ${row.sub_status} but worktree retained` });
        }
      }
    }

    // 2. Scan local agent/* branches
    const branchOut = gitSync(opts.workspaceRoot, ["branch", "--list", "agent/*"]);
    if (branchOut.ok) {
      const branches = branchOut.stdout
        .split("\n")
        .map((s) => s.replace(/^[*+ ]+/, "").trim())
        .filter(Boolean);
      for (const branch of branches) {
        // branch form: agent/<assignee>/<task-id>
        const parts = branch.split("/");
        if (parts.length !== 3) {
          out.orphan_branches.push({ branch, reason: "branch path != agent/<assignee>/<task-id>" });
          continue;
        }
        const taskId = parts[2];
        const row = Tracker.get(taskId);
        if (!row) {
          out.orphan_branches.push({ branch, reason: "no sqlite row for task" });
          continue;
        }
        if (TERMINAL.includes(row.sub_status)) {
          out.orphan_branches.push({ branch, reason: `task is ${row.sub_status} but branch retained` });
        }
      }
    }

    // 3. Apply if not dry-run
    if (!opts.dryRun) {
      for (const o of out.orphan_worktrees) {
        const parsed = parseWorktreeDir(o.dir);
        if (!parsed) continue;
        try {
          Worktree.remove(opts.workspaceRoot, parsed.agent, parsed.taskId, "");
          o.removed = true;
        } catch (err) {
          o.removed = false;
          api.logger.warn(`openclaw-mao: prune worktree ${o.dir} failed: ${(err as Error).message}`);
        }
      }
      for (const o of out.orphan_branches) {
        const r = gitSync(opts.workspaceRoot, ["branch", "-D", o.branch]);
        o.removed = r.ok;
        if (!r.ok) api.logger.warn(`openclaw-mao: prune branch ${o.branch} failed: ${r.stderr}`);
      }
    }

    api.logger.info(
      `openclaw-mao: prune ${opts.dryRun ? "(dry-run)" : ""} found ${out.orphan_worktrees.length} orphan worktree(s), ${out.orphan_branches.length} orphan branch(es)`,
    );
    return out;
  },
};
