import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}
import { Tracker, type TaskRow, type DispatchMode } from "./tracker.ts";
import { Worktree } from "./worktree.ts";
import { Verifier, type VerifyMode } from "./verifier.ts";
import { Chain } from "./chain.ts";
import { Notifier } from "./notifier.ts";
import { buildManualPlan, type ManualPlan } from "./prompt-templates.ts";

export interface DispatchInput {
  type: TaskRow["type"];
  priority?: TaskRow["priority"];
  description: string;
  branch?: string;
  planDoc?: string;
  parentTask?: string;
  reviewRequired?: boolean;
  mode?: DispatchMode;     // v0.2.1: "auto" (default) spawns CLI; "manual" prepares worktree + prompt for tui
}

// v0.2.0: assignee is the *external CLI* mao spawns, not an OpenClaw-internal agent.
// `kimi`     → /home/admin/.local/bin/kimi (Kimi Code CLI, K2.6, user OAuth)
// `opencode` → /home/admin/.npm-global/bin/opencode (oh-my-openagent + sisyphus 17-agent swarm)
const ASSIGNEE_BY_TYPE: Record<TaskRow["type"], string> = {
  bugfix:     "kimi",
  feature:    "opencode",
  refactor:   "opencode",
  "plan-doc": "opencode",
  review:     "opencode",
};

const TIMEOUT_MIN_BY_TYPE: Record<TaskRow["type"], number> = {
  bugfix: 15,
  feature: 60,
  refactor: 120,
  "plan-doc": 30,
  review: 999, // user-driven, effectively no timeout
};

const MAX_TURNS = 8;

function newTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultBranch(taskId: string, assignee: string, override?: string): string {
  return override ?? `agent/${assignee}/${taskId}`;
}

interface ResolvedConfig {
  workspaceRoot: string;
  baseBranch: string;
  verifyMode: VerifyMode;
  concurrencyLimit: number;
  highPriorityMultiplier: number;
  agentBinaries: { kimi: string; opencode: string };
}

function readConfig(api: OpenClawPluginApi): ResolvedConfig {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const bins = (cfg.agentBinaries as { kimi?: string; opencode?: string } | undefined) ?? {};
  return {
    workspaceRoot: expandHome((cfg.workspaceRoot as string) ?? "~/.openclaw/workspace"),
    baseBranch: (cfg.baseBranch as string) ?? "main",
    verifyMode: (cfg.verifyMode as VerifyMode) ?? "git",
    concurrencyLimit: (cfg.concurrencyLimit as number) ?? 3,
    agentBinaries: { kimi: bins.kimi ?? "kimi", opencode: bins.opencode ?? "opencode" },
    highPriorityMultiplier: (cfg.highPriorityMultiplier as number) ?? 1.5,
  };
}

function effectiveTimeoutMs(type: TaskRow["type"], priority: TaskRow["priority"], multiplier: number): number {
  const base = TIMEOUT_MIN_BY_TYPE[type] * 60_000;
  return priority === "high" ? Math.round(base * multiplier) : base;
}

function renderInitialPrompt(row: TaskRow): string {
  return [
    `[MAO TASK ${row.task_id}]`,
    `Type: ${row.type} | Priority: ${row.priority}`,
    `Branch: ${row.branch ?? "(not set)"}`,
    row.worktree_path ? `Working directory: ${row.worktree_path}` : null,
    row.plan_doc ? `Plan doc: ${row.plan_doc}` : null,
    "",
    `Task description:`,
    row.description,
    "",
    `When you are done, your final message MUST start with "DONE:" followed by a one-line summary.`,
    `If you need clarification, start your message with "CLARIFY:".`,
    `If you need more turns to think, just continue working — your final reply ends the task.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function renderContinuationPrompt(): string {
  return `Continue the task. If you've finished, reply with "DONE: <one-line summary>". If you need clarification, reply "CLARIFY: <question>".`;
}

interface SpawnTurnIn {
  agent: string;          // "kimi" or "opencode"
  message: string;
  cwd?: string;
  timeoutMs: number;
  isResume: boolean;      // first turn: false; subsequent: true (continue session)
  binaries: { kimi: string; opencode: string };
  sessionName?: string;   // Wave 3: tmux session name (undefined = old direct-spawn path)
}

interface SpawnTurnOut {
  exitCode: number;
  stdout: string;
  stderr: string;
  killedByTimeout: boolean;
  finalText: string;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[\[[0-9;]*[a-zA-Z]/g, "");
}

/* ── Wave 3 tmux helpers ───────────────────────────────────────────── */

function shortTaskId(taskId: string): string {
  return taskId.slice(-6);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function ensureTmuxSession(taskId: string): string {
  const short = shortTaskId(taskId);
  let name = `mao-${short}`;
  let r = spawnSync("tmux", ["has-session", "-t", name], { encoding: "utf8" });
  if (r.status === 0) return name;
  r = spawnSync("tmux", ["new-session", "-d", "-s", name, "-x", "200", "-y", "50", "bash"], { encoding: "utf8" });
  if (r.status !== 0) {
    name = `mao-${short}-${Date.now() % 10000}`;
    spawnSync("tmux", ["new-session", "-d", "-s", name, "-x", "200", "-y", "50", "bash"], { encoding: "utf8" });
  }
  return name;
}

async function pollLogUntilSentinelOrTimeout(
  path: string,
  timeoutMs: number,
): Promise<{ content: string; exitCode: number; timedOut: boolean }> {
  const start = Date.now();
  let content = "";
  let exitCode = -1;
  const sentinelRe = /__MAO_TURN_EXIT_(\d+)_END__/;
  const { readFile } = await import("node:fs/promises");
  while (Date.now() - start < timeoutMs) {
    try {
      content = await readFile(path, "utf8");
      const m = content.match(sentinelRe);
      if (m) {
        exitCode = parseInt(m[1], 10);
        content = content.replace(sentinelRe, "").trimEnd();
        return { content, exitCode, timedOut: false };
      }
    } catch { /* file may not exist yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { content, exitCode: -1, timedOut: true };
}

/**
 * v0.2.1 wave 2: extract the external CLI session id so the user can later
 * resume via `<cli> --session <id>` inside the worktree cwd.
 * Returns null if anything goes wrong — silent fallback.
 */
export function extractSessionId(
  agent: string,
  stdout: string,
  cwd: string,
  binaries: { kimi: string; opencode: string },
): string | null {
  const clean = stripAnsi(stdout);
  if (agent === "kimi") {
    const m = clean.match(/To resume this session:\s*kimi\s+-r\s+([0-9a-f-]+)/i);
    return m?.[1] ?? null;
  }
  if (agent === "opencode") {
    const r = spawnSync(binaries.opencode, ["session", "list", "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: `/home/admin/.local/bin:/home/admin/.npm-global/bin:${process.env.PATH ?? ""}` },
    });
    if (r.status !== 0) return null;
    try {
      const lines = (r.stdout ?? "").split("\n");
      const start = lines.findIndex((l) => l.trim().startsWith("[") || l.trim().startsWith("{"));
      const jsonText = start >= 0 ? lines.slice(start).join("\n") : r.stdout;
      const parsed = JSON.parse(jsonText);
      const arr = Array.isArray(parsed) ? parsed : (parsed.sessions ?? parsed.data ?? []);
      const first = arr[0];
      return first?.id ?? first?.session_id ?? first?.sessionId ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function extractFinalText(stdout: string, agent: string): string {
  const clean = stripAnsi(stdout);
  if (agent === "kimi") {
    // `kimi --quiet` outputs the final assistant text on first non-empty line(s),
    // then a "To resume this session: kimi -r <uuid>" hint.
    for (const line of clean.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("To resume this session:")) break;
      return t;
    }
    return "";
  }
  if (agent === "opencode") {
    // `opencode run --format default` prints a banner ("> Sisyphus - ...") plus
    // optional warnings, then the final assistant text. Walk from the bottom up.
    const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.startsWith("> ")) continue;                          // agent banner
      if (l.startsWith("!") && /not found/.test(l)) continue;    // fallback warning
      return l;
    }
    return lines.length ? lines[lines.length - 1] : "";
  }
  // unknown agent: fallback to last non-empty
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

type TurnLoopOutcome =
  | { kind: "done"; finalText: string; turns: number }
  | { kind: "clarify"; clarifyText: string; turns: number }
  | { kind: "max_turns"; turns: number }
  | { kind: "timeout" }
  | { kind: "agent_error"; error: string };

interface TurnLoopInput {
  initialMessage: string;
  totalTimeoutMs: number;
  sessionName?: string;
}

async function runTurnLoop(
  api: OpenClawPluginApi,
  row: TaskRow,
  worktreePath: string,
  opts: TurnLoopInput,
): Promise<TurnLoopOutcome> {
  const cfg = readConfig(api);
  const startedAt = Date.now();
  let turnIdx = 0;
  while (turnIdx < MAX_TURNS) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= opts.totalTimeoutMs) {
      api.logger.warn(`openclaw-mao: task ${row.task_id} loop timed out after ${elapsed}ms`);
      return { kind: "timeout" };
    }
    turnIdx += 1;
    const remaining = opts.totalTimeoutMs - elapsed;
    const message = turnIdx === 1 ? opts.initialMessage : renderContinuationPrompt();

    const out = await spawnAgentTurn({
      agent: row.assignee,
      message,
      cwd: worktreePath,
      timeoutMs: remaining,
      isResume: turnIdx > 1,           // continue cwd session for turn 2+
      binaries: cfg.agentBinaries,
      sessionName: opts.sessionName,
    });
    if (out.killedByTimeout) return { kind: "timeout" };
    if (out.exitCode !== 0) return { kind: "agent_error", error: out.stderr || `agent exit ${out.exitCode}` };

    // v0.2.1 wave 2: capture external session id on the first turn (free for kimi via stdout regex,
    // requires extra spawn for opencode but cheap; silent fallback to null on any error)
    if (turnIdx === 1 && !row.external_session_id) {
      const sid = extractSessionId(row.assignee, out.stdout, worktreePath, cfg.agentBinaries);
      if (sid) {
        Tracker.update(row.task_id, { external_session_id: sid });
        api.logger.info(`openclaw-mao: task ${row.task_id} external_session_id=${sid}`);
      }
    }

    api.logger.info(`openclaw-mao: task ${row.task_id} turn ${turnIdx} → "${out.finalText.slice(0, 80)}"`);

    if (out.finalText.startsWith("DONE:")) return { kind: "done", finalText: out.finalText, turns: turnIdx };
    if (out.finalText.startsWith("CLARIFY:")) return { kind: "clarify", clarifyText: out.finalText.slice("CLARIFY:".length).trim(), turns: turnIdx };
  }
  return { kind: "max_turns", turns: turnIdx };
}

function spawnAgentTurn(input: SpawnTurnIn): Promise<SpawnTurnOut> {
  return new Promise((resolve) => {
    const cwd = input.cwd ?? process.cwd();
    let cmd: string;
    let args: string[];

    if (input.agent === "kimi") {
      cmd = input.binaries.kimi;
      args = ["--quiet", "-w", cwd];
      if (input.isResume) args.push("-C");
      args.push("-p", input.message);
    } else if (input.agent === "opencode") {
      cmd = input.binaries.opencode;
      args = ["run", input.message, "--dir", cwd, "--dangerously-skip-permissions", "--format", "default"];
      if (input.isResume) args.push("--continue");
    } else {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: `unknown assignee: ${input.agent} (expected "kimi" or "opencode")`,
        killedByTimeout: false,
        finalText: "",
      });
      return;
    }

    if (input.sessionName) {
      const logFile = `/tmp/${input.sessionName}-turn-${Date.now()}.log`;
      const shellLine = [
        `export PATH=/home/admin/.local/bin:/home/admin/.npm-global/bin:$PATH`,
        `cd ${shellEscape(cwd)}`,
        `${shellEscape(cmd)} ${args.map(shellEscape).join(" ")} 2>&1 | tee ${shellEscape(logFile)}`,
        `echo "__MAO_TURN_EXIT_$?_END__"`,
      ].join(" && ");

      spawnSync("tmux", ["send-keys", "-t", input.sessionName, shellLine, "Enter"], { encoding: "utf8" });

      void (async () => {
        const result = await pollLogUntilSentinelOrTimeout(logFile, input.timeoutMs);
        resolve({
          exitCode: result.exitCode,
          stdout: result.content,
          stderr: "",
          killedByTimeout: result.timedOut,
          finalText: extractFinalText(result.content, input.agent),
        });
      })();
      return;
    }

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        PATH: `/home/admin/.local/bin:/home/admin/.npm-global/bin:${process.env.PATH ?? ""}`,
      },
    });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        killedByTimeout,
        finalText: extractFinalText(stdout, input.agent),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), killedByTimeout, finalText: "" });
    });
  });
}

export const Dispatcher = {
  create(api: OpenClawPluginApi, input: DispatchInput): { ok: boolean; row?: TaskRow; manual_plan?: ManualPlan; error?: string } {
    const cfg = readConfig(api);

    // Chain validation must run before insert (cycle / depth check)
    const ancestry = Chain.validateAncestry(input.parentTask);
    if (!ancestry.ok) {
      return { ok: false, error: `chain ancestry: ${ancestry.error}` };
    }
    const blockVerdict = Chain.shouldBlockOnInsert(input.parentTask);
    if (blockVerdict.blocked && blockVerdict.reason === "unknown_parent") {
      return { ok: false, error: blockVerdict.detail ?? "unknown parent" };
    }
    if (blockVerdict.blocked && blockVerdict.reason === "parent_terminal_failed") {
      return { ok: false, error: blockVerdict.detail ?? "parent terminally failed" };
    }
    const startSubStatus: TaskRow["sub_status"] = blockVerdict.blocked ? "blocked" : "pending";

    const taskId = newTaskId();
    const assignee = ASSIGNEE_BY_TYPE[input.type] ?? "opencode-dev";
    const branch = defaultBranch(taskId, assignee, input.branch);
    const mode: DispatchMode = input.mode ?? "auto";

    const row = Tracker.insert({
      task_id: taskId,
      type: input.type,
      priority: input.priority ?? "medium",
      description: input.description,
      assignee,
      branch,
      worktree_path: null,
      openclaw_task_id: null,
      openclaw_parent_task_id: input.parentTask ?? null,
      plan_doc: input.planDoc ?? null,
      review_required: input.reviewRequired ?? input.type !== "bugfix",
      result_json: null,
      error: null,
      sub_status: startSubStatus,
      mode,
      dispatched_at: null,
      completed_at: null,
    });

    if (startSubStatus === "blocked") {
      api.logger.info(`openclaw-mao: task ${taskId} BLOCKED on parent ${input.parentTask}`);
      return { ok: true, row };
    }

    // Manual mode: create worktree, write awaiting_human_work, build prompt+ssh and return — no LLM spawn.
    if (mode === "manual") {
      try {
        const wt = Worktree.create(cfg.workspaceRoot, assignee, taskId, branch, cfg.baseBranch);
        Tracker.update(taskId, {
          sub_status: "awaiting_human_work",
          worktree_path: wt.worktreePath,
          dispatched_at: new Date().toISOString(),
        });
        const fresh = Tracker.get(taskId)!;
        const plan = buildManualPlan({
          taskId,
          type: input.type,
          description: input.description,
          branch,
          worktreePath: wt.worktreePath,
          planDoc: input.planDoc ?? null,
        });
        api.logger.info(`openclaw-mao: task ${taskId} → awaiting_human_work (manual mode, ${plan.recommended_agent})`);
        return { ok: true, row: fresh, manual_plan: plan };
      } catch (err) {
        const msg = (err as Error).message;
        Tracker.update(taskId, { sub_status: "failed", error: `worktree: ${msg}`, completed_at: new Date().toISOString() });
        api.logger.warn(`openclaw-mao: worktree creation failed for manual task=${taskId}: ${msg}`);
        return { ok: false, error: `worktree creation failed: ${msg}` };
      }
    }

    // Auto mode: existing flow — Dispatcher.run does worktree create + spawn CLI loop.
    const active = Tracker.countActive();
    if (active <= cfg.concurrencyLimit) {
      void Dispatcher.run(api, row).catch((err) =>
        api.logger.error(`openclaw-mao: dispatch failed task=${taskId}: ${(err as Error).message}`),
      );
    } else {
      api.logger.info(`openclaw-mao: task ${taskId} queued (active ${active} > limit ${cfg.concurrencyLimit})`);
    }
    return { ok: true, row };
  },

  async run(api: OpenClawPluginApi, row: TaskRow): Promise<void> {
    const cfg = readConfig(api);
    const timeoutMs = effectiveTimeoutMs(row.type, row.priority, cfg.highPriorityMultiplier);

    // Phase: dispatch — create worktree
    Tracker.update(row.task_id, { sub_status: "dispatch", dispatched_at: new Date().toISOString() });
    let worktreePath: string;
    try {
      const wt = Worktree.create(cfg.workspaceRoot, row.assignee, row.task_id, row.branch!, cfg.baseBranch);
      worktreePath = wt.worktreePath;
      Tracker.update(row.task_id, { worktree_path: worktreePath });
      api.logger.info(`openclaw-mao: worktree ready ${worktreePath} (task=${row.task_id})`);
    } catch (err) {
      const msg = (err as Error).message;
      Tracker.update(row.task_id, { sub_status: "failed", error: `worktree: ${msg}`, completed_at: new Date().toISOString() });
      api.logger.warn(`openclaw-mao: worktree creation failed for task=${row.task_id}: ${msg}`);
      Dispatcher.afterTerminal(api, row);
      return;
    }

    // Phase: running — multi-turn loop until DONE / CLARIFY / max turns / timeout
    const sessionName = ensureTmuxSession(row.task_id);
    Tracker.update(row.task_id, { sub_status: "running", tmux_session_name: sessionName });
    api.logger.info(`openclaw-mao: tmux session ${sessionName} ready for task ${row.task_id}`);
    const outcome = await runTurnLoop(api, row, worktreePath, {
      initialMessage: renderInitialPrompt({ ...row, worktree_path: worktreePath }),
      totalTimeoutMs: timeoutMs,
      sessionName,
    });

    await Dispatcher.handleTurnOutcome(api, Tracker.get(row.task_id)!, worktreePath, outcome, cfg.verifyMode);
  },

  // Centralised state-transition logic shared by run() / continue() / resumeAfterReviewFail().
  async handleTurnOutcome(
    api: OpenClawPluginApi,
    row: TaskRow,
    worktreePath: string,
    outcome: TurnLoopOutcome,
    verifyMode: VerifyMode,
  ): Promise<void> {
    if (outcome.kind === "clarify") {
      Tracker.update(row.task_id, { sub_status: "awaiting_clarification", clarify_question: outcome.clarifyText });
      api.logger.info(`openclaw-mao: task ${row.task_id} → awaiting_clarification: "${outcome.clarifyText.slice(0, 80)}"`);
      return; // not terminal — chain children stay blocked
    }
    if (outcome.kind === "timeout") {
      Tracker.update(row.task_id, { sub_status: "failed", error: `task timeout`, completed_at: new Date().toISOString() });
      api.logger.warn(`openclaw-mao: task ${row.task_id} timed out`);
      Dispatcher.afterTerminal(api, Tracker.get(row.task_id)!);
      return;
    }
    if (outcome.kind === "agent_error") {
      Tracker.update(row.task_id, { sub_status: "failed", error: outcome.error, completed_at: new Date().toISOString() });
      api.logger.warn(`openclaw-mao: task ${row.task_id} agent error: ${outcome.error.slice(0, 200)}`);
      Dispatcher.afterTerminal(api, Tracker.get(row.task_id)!);
      return;
    }
    if (outcome.kind === "max_turns") {
      Tracker.update(row.task_id, { sub_status: "failed", error: `max turns (${MAX_TURNS}) reached without DONE`, completed_at: new Date().toISOString() });
      api.logger.warn(`openclaw-mao: task ${row.task_id} hit max turns`);
      Dispatcher.afterTerminal(api, Tracker.get(row.task_id)!);
      return;
    }

    // outcome.kind === "done" — verify, then PUSHED → REVIEWING / COMPLETED
    Tracker.update(row.task_id, { sub_status: "verifying" });
    const verdict = Verifier.verify(worktreePath, row.branch!, verifyMode);
    if (!verdict.ok) {
      if (verdict.reason === "uncommitted_changes" && row.retry_run < 1) {
        api.logger.warn(
          `openclaw-mao: task ${row.task_id} verify=uncommitted_changes → auto-retry (zero-commit antipattern), retry_run will be ${row.retry_run + 1}`,
        );
        Tracker.update(row.task_id, { sub_status: "failed", error: `verify uncommitted_changes: ${verdict.detail ?? ""}` });
        void Dispatcher.retryFromFailure(api, Tracker.get(row.task_id)!).catch((err) =>
          api.logger.error(`openclaw-mao: auto-retry threw task=${row.task_id}: ${(err as Error).message}`),
        );
        return;
      }
      Tracker.update(row.task_id, {
        sub_status: "failed",
        error: `verify ${verdict.reason}: ${verdict.detail ?? ""}`,
        completed_at: new Date().toISOString(),
      });
      api.logger.warn(`openclaw-mao: task ${row.task_id} VERIFYING failed: ${verdict.reason}`);
      Dispatcher.afterTerminal(api, Tracker.get(row.task_id)!);
      return;
    }

    Tracker.update(row.task_id, {
      sub_status: "pushed",
      result_json: JSON.stringify({ summary: outcome.finalText, turns: outcome.turns, verifyMode }),
    });

    if (row.review_required) {
      Tracker.update(row.task_id, { sub_status: "reviewing" });
      api.logger.info(`openclaw-mao: task ${row.task_id} → reviewing (awaiting review-result)`);
      Notifier.sendDiscord(
        api,
        `📋 mao review needed: ${row.task_id} (${row.type}) — branch ${row.branch}\nRun \`openclaw mao review-bundle ${row.task_id}\` then \`openclaw mao review-result ${row.task_id} --verdict pass|fail --feedback "..."\``,
      );
      return; // not terminal
    }

    Tracker.update(row.task_id, { sub_status: "completed", completed_at: new Date().toISOString() });
    api.logger.info(`openclaw-mao: task ${row.task_id} → completed (no review required)`);
    Dispatcher.afterTerminal(api, Tracker.get(row.task_id)!);
  },

  // Called from any terminal-state write inside run(): notify chain (unblock children
  // or cascade-cancel) then pull next pending task if concurrency allows.
  afterTerminal(api: OpenClawPluginApi, terminalRow?: TaskRow): void {
    if (terminalRow) {
      const fresh = Tracker.get(terminalRow.task_id) ?? terminalRow;
      // Discord alert on terminal failure / cancellation (best-effort, silent if no channel)
      if (fresh.sub_status === "failed") {
        Notifier.sendDiscord(api, `❌ mao FAILED: ${fresh.task_id} (${fresh.type}) — ${(fresh.error ?? "(no error msg)").slice(0, 200)}`);
      }
      Chain.afterParentTerminal(api, fresh);
    }
    const cfg = readConfig(api);
    const active = Tracker.countActive();
    if (active >= cfg.concurrencyLimit) return;
    const pendings = Tracker.list({ sub_status: "pending" });
    if (pendings.length === 0) return;
    const next = pendings[pendings.length - 1]; // FIFO (list returns newest-first)
    api.logger.info(`openclaw-mao: pulling pending task ${next.task_id} into running queue`);
    void Dispatcher.run(api, next).catch((err) =>
      api.logger.error(`openclaw-mao: pulled task failed task=${next.task_id}: ${(err as Error).message}`),
    );
  },

  cancel(api: OpenClawPluginApi, taskId: string): boolean {
    const row = Tracker.get(taskId);
    if (!row) return false;
    const terminal = ["completed", "failed", "cancelled"];
    if (terminal.includes(row.sub_status)) return false;
    Tracker.update(taskId, { sub_status: "cancelled", completed_at: new Date().toISOString(), error: "cancelled by user" });
    Dispatcher.afterTerminal(api, row);
    return true;
  },

  // Called from review-result when verdict=fail and retry budget remains.
  // Re-runs the multi-turn loop with review feedback as the initial message.
  async resumeAfterReviewFail(api: OpenClawPluginApi, taskId: string): Promise<void> {
    const row = Tracker.get(taskId);
    if (!row) return api.logger.warn(`openclaw-mao: resumeAfterReviewFail: task ${taskId} not found`);
    if (row.sub_status !== "running") return api.logger.warn(`openclaw-mao: resumeAfterReviewFail: task ${taskId} sub_status=${row.sub_status}, expected running`);
    if (!row.worktree_path) {
      Tracker.update(taskId, { sub_status: "failed", error: "resume: no worktree_path", completed_at: new Date().toISOString() });
      Dispatcher.afterTerminal(api, row);
      return;
    }

    const cfg = readConfig(api);
    const feedbackMsg = [
      `[REVIEW FEEDBACK — please incorporate and continue]`,
      row.review_feedback ?? "(no feedback text)",
      "",
      `When you've addressed the feedback, reply "DONE: <one-line summary of what changed>".`,
      `If the feedback is unclear, reply "CLARIFY: <your question>" and I'll get back to you.`,
    ].join("\n");

    const outcome = await runTurnLoop(api, row, row.worktree_path, {
      initialMessage: feedbackMsg,
      totalTimeoutMs: 600_000,
    });
    await Dispatcher.handleTurnOutcome(api, Tracker.get(taskId)!, row.worktree_path, outcome, cfg.verifyMode);
  },

  async continue(api: OpenClawPluginApi, taskId: string, userMessage: string): Promise<{ ok: boolean; error?: string }> {
    const row = Tracker.get(taskId);
    if (!row) return { ok: false, error: `task ${taskId} not found` };

    if (row.sub_status === "awaiting_clarification") {
      return Dispatcher._continueClarification(api, row, userMessage);
    }

    if (row.sub_status === "failed") {
      return Dispatcher.retryFromFailure(api, row, userMessage);
    }

    return { ok: false, error: `task ${taskId} sub_status=${row.sub_status}, expected awaiting_clarification or failed` };
  },

  async _continueClarification(api: OpenClawPluginApi, row: TaskRow, userMessage: string): Promise<{ ok: boolean; error?: string }> {
    if (!row.worktree_path) return { ok: false, error: `task ${row.task_id} has no worktree_path` };

    const cfg = readConfig(api);
    const followUp = [
      `[USER REPLY to your CLARIFY question]`,
      userMessage,
      "",
      `When you've finished, reply "DONE: <summary>". If you still need clarification, reply "CLARIFY: <question>".`,
    ].join("\n");

    Tracker.update(row.task_id, { sub_status: "running", clarify_question: null });

    void (async () => {
      const outcome = await runTurnLoop(api, Tracker.get(row.task_id)!, row.worktree_path!, {
        initialMessage: followUp,
        totalTimeoutMs: 600_000,
      });
      await Dispatcher.handleTurnOutcome(api, Tracker.get(row.task_id)!, row.worktree_path!, outcome, cfg.verifyMode);
    })().catch((err) => api.logger.error(`openclaw-mao: continue task=${row.task_id} threw: ${(err as Error).message}`));

    return { ok: true };
  },

  async retryFromFailure(
    api: OpenClawPluginApi,
    row: TaskRow,
    userMessage?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (row.sub_status !== "failed") {
      return { ok: false, error: `expected failed, got ${row.sub_status}` };
    }
    if (!row.worktree_path) {
      return { ok: false, error: "task has no worktree_path (cannot retry)" };
    }
    if (row.retry_run >= 1) {
      return { ok: false, error: `retry budget exhausted (retry_run=${row.retry_run})` };
    }

    const cfg = readConfig(api);
    Tracker.update(row.task_id, {
      sub_status: "running",
      retry_run: row.retry_run + 1,
      error: null,
      completed_at: null,
    });

    const retryMessage = userMessage ?? Dispatcher._autoRetryMessage(row.error ?? "");

    void (async () => {
      const outcome = await runTurnLoop(api, Tracker.get(row.task_id)!, row.worktree_path!, {
        initialMessage: retryMessage,
        totalTimeoutMs: 600_000,
      });
      await Dispatcher.handleTurnOutcome(api, Tracker.get(row.task_id)!, row.worktree_path!, outcome, cfg.verifyMode);
    })().catch((err) => api.logger.error(`openclaw-mao: retryFromFailure task=${row.task_id} threw: ${(err as Error).message}`));

    return { ok: true };
  },

  _autoRetryMessage(priorError: string): string {
    if (priorError.includes("uncommitted_changes")) {
      return [
        `[RETRY — your previous DONE was missing the commit step]`,
        "",
        `You wrote files but never ran git commit. The task contract requires:`,
        `  1. git add . on the worktree`,
        `  2. git commit -m "<conventional message>"`,
        `  3. git push origin HEAD`,
        "",
        `Please do those three steps now, then reply "DONE: <summary>".`,
        `Do NOT modify code further unless you must fix a real issue.`,
      ].join("\n");
    }
    if (priorError.includes("commits_not_pushed")) {
      return `[RETRY] Your commits exist locally but were never pushed. Run \`git push origin HEAD\` and reply DONE: <summary>.`;
    }
    return `[RETRY] Your previous attempt failed with: "${priorError.slice(0, 200)}". Please address and reply DONE: <summary>.`;
  },

  cleanup(api: OpenClawPluginApi, taskId: string): { ok: boolean; removedWorktree: boolean } {
    const cfg = readConfig(api);
    const row = Tracker.get(taskId);
    if (!row) return { ok: false, removedWorktree: false };
    Worktree.remove(cfg.workspaceRoot, row.assignee, row.task_id, row.branch ?? "");
    return { ok: true, removedWorktree: true };
  },
};
