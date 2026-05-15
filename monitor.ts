import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";
import { Notifier } from "./notifier.ts";
import { Verifier, type VerifyMode } from "./verifier.ts";
import { extractSessionId } from "./dispatcher.ts";
import { Worktree } from "./worktree.ts";

export interface MonitorOpts {
  stuckHeartbeatMin: number;
  verifyingTimeoutMin: number;
  workspaceRoot?: string;
  diskAlertGiB?: number;
  baseBranch?: string;       // for human-work completion check
  verifyMode?: VerifyMode;   // for verifier on auto-promoted manual tasks
  agentBinaries?: { kimi: string; opencode: string };
  worktreeRetentionHours?: number;   // 0 disables retention sweep
  unhealthyStepThreshold?: number;   // default 80
  unhealthyNoMtimeMin?: number;      // default 10
  loopHealthWarmupMin?: number;      // default 3
  tmuxRetentionMin?: number;         // default 60
}

export interface MonitorResult {
  ran_at: string;
  stuck_running: { task_id: string; age_min: number }[];
  stuck_verifying: { task_id: string; age_min: number }[];
  human_work_promoted: { task_id: string; new_status: string }[];
  worktrees_pruned: { task_id: string; age_hours: number }[];
  failed_count: number;
  disk: { worktrees_bytes: number; threshold_bytes: number; alert: boolean } | null;
  degraded_loops?: { task_id: string; step_count: number | null; mtime_age_min: number | null }[];
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

function findLatestWorktreeMtime(worktreePath: string): Date | null {
  try {
    let latest = 0;
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
        const full = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(full);
        else {
          const m = statSync(full).mtimeMs;
          if (m > latest) latest = m;
        }
      }
    };
    walk(worktreePath);
    return latest > 0 ? new Date(latest) : null;
  } catch {
    return null;
  }
}

function probeOpencodeStepCount(row: TaskRow): number | null {
  if (row.assignee !== "opencode") return null;
  if (!row.dispatched_at) return null;
  const dispatched = new Date(row.dispatched_at);
  try {
    const logDir = `${process.env.HOME}/.local/share/opencode/log`;
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ name: f, mtime: statSync(`${logDir}/${f}`).mtimeMs }))
      .filter((x) => x.mtime >= dispatched.getTime())
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const target = `${logDir}/${files[0].name}`;
    const grep = spawnSync("grep", ["-c", "service=session.prompt status=completed", target], { encoding: "utf8" });
    if (grep.status !== 0 && grep.status !== 1) return null;
    return parseInt((grep.stdout ?? "0").trim(), 10) || 0;
  } catch {
    return null;
  }
}

interface ProbeResult {
  loop_health: "healthy" | "degraded" | "unknown";
  step_count: number | null;
  worktree_mtime: Date | null;
  mtime_age_min: number | null;
  reason: string;
}

function probeLoopHealth(row: TaskRow, opts: MonitorOpts): ProbeResult {
  const elapsedMin = row.dispatched_at ? Math.floor((Date.now() - new Date(row.dispatched_at).getTime()) / 60_000) : 0;
  const warmupMin = opts.loopHealthWarmupMin ?? 3;
  if (elapsedMin < warmupMin) {
    return { loop_health: "unknown", step_count: null, worktree_mtime: null, mtime_age_min: null, reason: `warmup (elapsed ${elapsedMin}m < ${warmupMin}m)` };
  }
  const stepCount = probeOpencodeStepCount(row);
  const mtime = row.worktree_path ? findLatestWorktreeMtime(row.worktree_path) : null;
  const mtimeAgeMin = mtime ? Math.floor((Date.now() - mtime.getTime()) / 60_000) : null;
  const stepThreshold = opts.unhealthyStepThreshold ?? 80;
  const mtimeStaleMin = opts.unhealthyNoMtimeMin ?? 10;

  if (stepCount === null) {
    if (mtimeAgeMin !== null && mtimeAgeMin >= mtimeStaleMin && elapsedMin >= mtimeStaleMin + warmupMin) {
      return { loop_health: "degraded", step_count: null, worktree_mtime: mtime, mtime_age_min: mtimeAgeMin, reason: `worktree idle ${mtimeAgeMin}m (single signal: kimi/unknown step_count)` };
    }
    return { loop_health: "unknown", step_count: null, worktree_mtime: mtime, mtime_age_min: mtimeAgeMin, reason: "step_count unavailable" };
  }

  if (stepCount >= stepThreshold * 1.5) {
    return { loop_health: "degraded", step_count: stepCount, worktree_mtime: mtime, mtime_age_min: mtimeAgeMin, reason: `step_count=${stepCount} > 1.5x threshold` };
  }
  if (stepCount >= stepThreshold && (mtimeAgeMin === null || mtimeAgeMin >= mtimeStaleMin)) {
    return { loop_health: "degraded", step_count: stepCount, worktree_mtime: mtime, mtime_age_min: mtimeAgeMin, reason: `step_count=${stepCount} AND worktree idle ${mtimeAgeMin}m` };
  }
  return { loop_health: "healthy", step_count: stepCount, worktree_mtime: mtime, mtime_age_min: mtimeAgeMin, reason: "ok" };
}

export const Monitor = {
  tick(api: OpenClawPluginApi, opts: MonitorOpts): MonitorResult {
    const out: MonitorResult = { ran_at: new Date().toISOString(), stuck_running: [], stuck_verifying: [], human_work_promoted: [], worktrees_pruned: [], failed_count: 0, disk: null };

    // 1. Running tasks: stuck = worktree idle > stuckHeartbeatMin (not absolute task age,
    //    so retries / long-running but actively-committing tasks don't get killed)
    const running = Tracker.list({ sub_status: "running" });
    for (const t of running) {
      const mtime = t.worktree_path ? findLatestWorktreeMtime(t.worktree_path) : null;
      const idleMin = mtime
        ? Math.floor((Date.now() - mtime.getTime()) / 60_000)
        : ageMinutes(t.dispatched_at); // fallback when worktree missing
      if (idleMin >= opts.stuckHeartbeatMin) {
        const reason = mtime
          ? `STUCK: worktree idle ${idleMin}min (threshold ${opts.stuckHeartbeatMin}min, mapped to TaskFlow.lost)`
          : `STUCK: no worktree mtime, fallback age ${idleMin}min (threshold ${opts.stuckHeartbeatMin}min)`;
        Tracker.update(t.task_id, {
          sub_status: "failed",
          error: reason,
          completed_at: new Date().toISOString(),
        });
        out.stuck_running.push({ task_id: t.task_id, age_min: idleMin });
        out.failed_count += 1;
        api.logger.warn(`openclaw-mao: monitor STUCK task=${t.task_id} (idle ${idleMin}min) → failed`);
        Notifier.sendDiscord(api, `⚠️ mao STUCK: ${t.task_id} (${t.type}) idle ${idleMin}min, agent=${t.assignee}`);
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

        // v0.2.1 wave 2: capture external session id (best-effort) before promoting state.
        if (!t.external_session_id && opts.agentBinaries) {
          const sid = extractSessionId(t.assignee, "", t.worktree_path, opts.agentBinaries);
          if (sid) Tracker.update(t.task_id, { external_session_id: sid });
        }

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

    // 4. Worktree retention sweep — auto-prune terminal tasks whose worktree+branch
    // have been kept past worktreeRetentionHours so users can no longer resume in tui.
    const retentionH = opts.worktreeRetentionHours ?? 24;
    if (retentionH > 0 && opts.workspaceRoot) {
      const cutoffMs = Date.now() - retentionH * 3_600_000;
      const terminal: TaskRow["sub_status"][] = ["completed", "failed", "cancelled"];
      const candidates = (Tracker.list() as TaskRow[]).filter(
        (t) =>
          terminal.includes(t.sub_status) &&
          t.completed_at &&
          new Date(t.completed_at).getTime() < cutoffMs &&
          t.worktree_path,
      );
      for (const t of candidates) {
        try {
          Worktree.remove(opts.workspaceRoot, t.assignee, t.task_id, t.branch ?? "");
          const ageH = t.completed_at
            ? Math.floor((Date.now() - new Date(t.completed_at).getTime()) / 3_600_000)
            : 0;
          out.worktrees_pruned.push({ task_id: t.task_id, age_hours: ageH });
          api.logger.info(`openclaw-mao: monitor pruned task ${t.task_id} worktree (age ${ageH}h, retention ${retentionH}h)`);
        } catch (err) {
          api.logger.warn(`openclaw-mao: monitor prune failed for ${t.task_id}: ${(err as Error).message}`);
        }
      }
    }

    // 6. Loop health probe: scan running tasks, detect degraded loops (one notification per task)
    const runningForHealth = Tracker.list({ sub_status: "running" });
    for (const t of runningForHealth) {
      const probe = probeLoopHealth(t, opts);
      Tracker.update(t.task_id, {
        loop_health: probe.loop_health,
        step_count: probe.step_count,
        last_worktree_mtime: probe.worktree_mtime ? probe.worktree_mtime.toISOString() : null,
      });
      if (probe.loop_health === "degraded" && !t.loop_health_notified_at) {
        api.logger.warn(`openclaw-mao: monitor LOOP_DEGRADED task=${t.task_id} reason="${probe.reason}"`);
        Notifier.sendDiscord(
          api,
          `⚠️ mao LOOP DEGRADED: ${t.task_id} (${t.type}, ${t.assignee}) — ${probe.reason}. ` +
          `Inspect via \`openclaw mao status ${t.task_id}\` or attach TUI: \`openclaw mao open ${t.task_id}\``,
        );
        Tracker.update(t.task_id, { loop_health_notified_at: new Date().toISOString() });
        out.degraded_loops = out.degraded_loops ?? [];
        out.degraded_loops.push({ task_id: t.task_id, step_count: probe.step_count, mtime_age_min: probe.mtime_age_min });
      }
    }

    // 5. Disk usage check on workspaceRoot/worktrees (best-effort via `du -sb`)
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

    // 7. Tmux session retention: kill sessions belonging to terminal tasks older than retention
    const tmuxRetentionMin = opts.tmuxRetentionMin ?? 60;
    const terminalForTmux: TaskRow["sub_status"][] = ["completed", "failed", "cancelled"];
    const terminalTasks = (Tracker.list() as TaskRow[]).filter(
      (t) => t.tmux_session_name && terminalForTmux.includes(t.sub_status) && t.completed_at,
    );
    for (const t of terminalTasks) {
      const age = (Date.now() - new Date(t.completed_at!).getTime()) / 60_000;
      if (age < tmuxRetentionMin) continue;
      const hasSess = spawnSync("tmux", ["has-session", "-t", t.tmux_session_name!], { encoding: "utf8" });
      if (hasSess.status !== 0) continue;
      const kill = spawnSync("tmux", ["kill-session", "-t", t.tmux_session_name!], { encoding: "utf8" });
      if (kill.status === 0) {
        api.logger.info(`openclaw-mao: monitor killed tmux session ${t.tmux_session_name} (task ${t.task_id} terminal age=${Math.floor(age)}m)`);
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
