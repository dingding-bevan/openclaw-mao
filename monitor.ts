import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker } from "./tracker.ts";
import { Notifier } from "./notifier.ts";

export interface MonitorOpts {
  stuckHeartbeatMin: number;
  verifyingTimeoutMin: number;
  workspaceRoot?: string;
  diskAlertGiB?: number;
}

export interface MonitorResult {
  ran_at: string;
  stuck_running: { task_id: string; age_min: number }[];
  stuck_verifying: { task_id: string; age_min: number }[];
  failed_count: number;
  disk: { worktrees_bytes: number; threshold_bytes: number; alert: boolean } | null;
}

function ageMinutes(iso: string | null): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
}

export const Monitor = {
  tick(api: OpenClawPluginApi, opts: MonitorOpts): MonitorResult {
    const out: MonitorResult = { ran_at: new Date().toISOString(), stuck_running: [], stuck_verifying: [], failed_count: 0, disk: null };

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

    // 3. Disk usage check on workspaceRoot/worktrees (best-effort via `du -sb`)
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
   * Idempotent: register a cron job that fires `openclaw mao monitor-tick` every 5 minutes.
   * Called from `mao setup` (NOT from register(api) — would deadlock).
   */
  ensureCronRegistered(api: OpenClawPluginApi): { ok: boolean; created?: boolean; existed?: boolean; error?: string } {
    // Check existing cron jobs for our id
    const list = spawnSync("openclaw", ["cron", "list", "--json"], { encoding: "utf8" });
    if (list.status === 0) {
      try {
        const parsed = JSON.parse(list.stdout);
        const jobs: any[] = Array.isArray(parsed) ? parsed : parsed.jobs ?? parsed.crons ?? [];
        if (jobs.some((j) => (j.id ?? j.name ?? "").includes("openclaw-mao-monitor"))) {
          return { ok: true, existed: true };
        }
      } catch {
        // fall through and try add anyway
      }
    }

    // Try add. Different OpenClaw versions accept different flags; we'll try the common form.
    const add = spawnSync(
      "openclaw",
      ["cron", "add", "--name", "openclaw-mao-monitor", "--schedule", "*/5 * * * *", "--command", "openclaw mao monitor-tick"],
      { encoding: "utf8" },
    );
    if (add.status !== 0) {
      api.logger.warn(`openclaw-mao: ensureCronRegistered failed: ${add.stderr ?? `exit ${add.status}`}`);
      return { ok: false, error: add.stderr ?? `exit ${add.status}` };
    }
    return { ok: true, created: true };
  },
};
