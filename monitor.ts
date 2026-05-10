import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";
import { Notifier } from "./notifier.ts";
import { Verifier, type VerifyMode } from "./verifier.ts";

export interface MonitorOpts {
  stuckHeartbeatMin: number;
  verifyingTimeoutMin: number;
  workspaceRoot?: string;
  diskAlertGiB?: number;
  baseBranch?: string;       // for human-work completion check
  verifyMode?: VerifyMode;   // for verifier on auto-promoted manual tasks
}

export interface MonitorResult {
  ran_at: string;
  stuck_running: { task_id: string; age_min: number }[];
  stuck_verifying: { task_id: string; age_min: number }[];
  human_work_promoted: { task_id: string; new_status: string }[];
  failed_count: number;
  disk: { worktrees_bytes: number; threshold_bytes: number; alert: boolean } | null;
}

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * v0.2.1: detect whether a manual-mode task has been completed by the human
 * working in the tui. Three conditions:
 *   1. working tree clean (no uncommitted changes)
 *   2. local HEAD == origin/<branch> (push synced)
 *   3. branch has at least one commit ahead of base (not empty work)
 */
function isHumanWorkComplete(worktreePath: string, branch: string, baseBranch: string): boolean {
  const status = gitSync(worktreePath, ["status", "--porcelain"]);
  if (!status.ok || status.stdout.trim()) return false;

  const localHead = gitSync(worktreePath, ["rev-parse", "HEAD"]);
  if (!localHead.ok) return false;
  const remoteHead = gitSync(worktreePath, ["rev-parse", `origin/${branch}`]);
  if (!remoteHead.ok || remoteHead.stdout.trim() !== localHead.stdout.trim()) return false;

  const ahead = gitSync(worktreePath, ["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
  if (!ahead.ok) return false;
  const aheadCount = parseInt(ahead.stdout.trim() || "0", 10);
  return aheadCount >= 1;
}

function ageMinutes(iso: string | null): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
}

export const Monitor = {
  tick(api: OpenClawPluginApi, opts: MonitorOpts): MonitorResult {
    const out: MonitorResult = { ran_at: new Date().toISOString(), stuck_running: [], stuck_verifying: [], human_work_promoted: [], failed_count: 0, disk: null };

    // 1. Running > stuckHeartbeatMin → mark failed (treated as `lost` per OpenClaw TaskFlow status enum)
    const running = Tracker.list({ sub_status: "running" });
    for (const t of running) {
      const age = ageMinutes(t.dispatched_at);
      if (age >= opts.stuckHeartbeatMin) {
        Tracker.update(t.task_id, {
          sub_status: "failed",
          error: `STUCK: running > ${opts.stuckHeartbeatMin}min (age=${age}min, mapped to TaskFlow.lost)`,
          completed_at: new Date().toISOString(),
        });
        out.stuck_running.push({ task_id: t.task_id, age_min: age });
        out.failed_count += 1;
        api.logger.warn(`openclaw-mao: monitor STUCK task=${t.task_id} (running ${age}min) → failed`);
        Notifier.sendDiscord(api, `⚠️ mao STUCK: ${t.task_id} (${t.type}) running ${age}min, agent=${t.assignee}`);
      }
    }

    // 2. Verifying > verifyingTimeoutMin → mark failed
    const verifying = Tracker.list({ sub_status: "verifying" });
    for (const t of verifying) {
      const age = ageMinutes(t.dispatched_at);
      if (age >= opts.verifyingTimeoutMin) {
        Tracker.update(t.task_id, {
          sub_status: "failed",
          error: `VERIFYING timeout > ${opts.verifyingTimeoutMin}min (age=${age}min)`,
          completed_at: new Date().toISOString(),
        });
        out.stuck_verifying.push({ task_id: t.task_id, age_min: age });
        out.failed_count += 1;
        api.logger.warn(`openclaw-mao: monitor VERIFYING-timeout task=${t.task_id} (${age}min) → failed`);
        Notifier.sendDiscord(api, `⚠️ mao VERIFYING timeout: ${t.task_id} (${age}min)`);
      }
    }

    // 3. Manual-mode tasks: detect completion (worktree clean + pushed + has commits)
    if (opts.baseBranch) {
      const baseBranch = opts.baseBranch;
      const verifyMode: VerifyMode = opts.verifyMode ?? "git";
      const awaiting = Tracker.list({ sub_status: "awaiting_human_work" }) as TaskRow[];
      for (const t of awaiting) {
        if (!t.worktree_path || !t.branch) continue;
        if (!isHumanWorkComplete(t.worktree_path, t.branch, baseBranch)) continue;

        api.logger.info(`openclaw-mao: monitor detected human work complete on task=${t.task_id}`);

        // Run verifier (same as auto-mode dispatcher.run path)
        Tracker.update(t.task_id, { sub_status: "verifying" });
        const verdict = Verifier.verify(t.worktree_path, t.branch, verifyMode);
        if (!verdict.ok) {
          Tracker.update(t.task_id, {
            sub_status: "failed",
            error: `verify ${verdict.reason}: ${verdict.detail ?? ""}`,
            completed_at: new Date().toISOString(),
          });
          api.logger.warn(`openclaw-mao: manual task ${t.task_id} verify failed: ${verdict.reason}`);
          Notifier.sendDiscord(api, `❌ mao manual task verify failed: ${t.task_id} — ${verdict.reason}`);
          out.human_work_promoted.push({ task_id: t.task_id, new_status: "failed" });
          continue;
        }

        // Take last commit message as summary signal
        const lastCommit = gitSync(t.worktree_path, ["log", "-1", "--pretty=%s"]).stdout.trim();
        Tracker.update(t.task_id, {
          sub_status: "pushed",
          result_json: JSON.stringify({ summary: `Manual mode complete (last commit: ${lastCommit})`, mode: "manual" }),
        });

        if (t.review_required) {
          Tracker.update(t.task_id, { sub_status: "reviewing" });
          api.logger.info(`openclaw-mao: manual task ${t.task_id} → reviewing`);
          Notifier.sendDiscord(
            api,
            `📋 mao manual review needed: ${t.task_id} (${t.type}) — ${lastCommit}`,
          );
          out.human_work_promoted.push({ task_id: t.task_id, new_status: "reviewing" });
        } else {
          Tracker.update(t.task_id, { sub_status: "completed", completed_at: new Date().toISOString() });
          api.logger.info(`openclaw-mao: manual task ${t.task_id} → completed`);
          out.human_work_promoted.push({ task_id: t.task_id, new_status: "completed" });
        }
      }
    }

    // 4. Disk usage check on workspaceRoot/worktrees (best-effort via `du -sb`)
    if (opts.workspaceRoot && opts.diskAlertGiB !== undefined && opts.diskAlertGiB > 0) {
      const wtPath = `${opts.workspaceRoot}/worktrees`;
      const r = spawnSync("du", ["-sb", wtPath], { encoding: "utf8", timeout: 30_000 });
      if (r.status === 0) {
        const bytes = parseInt(r.stdout.split(/\s+/)[0] ?? "0", 10);
        const threshold = opts.diskAlertGiB * 1024 ** 3;
        out.disk = { worktrees_bytes: bytes, threshold_bytes: threshold, alert: bytes >= threshold };
        if (out.disk.alert) {
          const gib = (bytes / 1024 ** 3).toFixed(2);
          api.logger.warn(`openclaw-mao: monitor disk usage ${gib}GiB >= ${opts.diskAlertGiB}GiB threshold`);
          Notifier.sendDiscord(api, `⚠️ mao disk: worktrees/ at ${gib}GiB (threshold ${opts.diskAlertGiB}GiB) — consider \`mao prune --apply\``);
        }
      }
    }

    return out;
  },

  /**
   * v0.2.0: OpenClaw `cron add` is an agent-message scheduler, not a generic shell-command
   * scheduler — it only supports `--agent <id> --message <text>` payloads, no `--command`.
   * Auto-registering `openclaw mao monitor-tick` therefore isn't possible without wrapping
   * monitor-tick inside a dedicated agent (out of scope for v0.2.0).
   *
   * For now we no-op and tell the user to schedule it via host crontab or systemd user timer.
   * `mao setup` reports skipped instead of failing.
   *
   * Manual registration example:
   *   crontab -e
   *   * /5 * * * * /home/admin/.npm-global/bin/openclaw mao monitor-tick >/dev/null 2>&1
   */
  ensureCronRegistered(api: OpenClawPluginApi): { ok: boolean; skipped: boolean; reason: string } {
    const reason =
      "OpenClaw cron only supports --agent --message scheduling, not raw shell commands. " +
      "Schedule `openclaw mao monitor-tick` via host crontab or systemd user timer instead. See README.";
    api.logger.info(`openclaw-mao: ensureCronRegistered skipped — ${reason}`);
    return { ok: true, skipped: true, reason };
  },
};
