import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}
import { Tracker, type TaskRow } from "./tracker.ts";
import { Worktree } from "./worktree.ts";
import { Verifier, type VerifyMode } from "./verifier.ts";
import { Chain } from "./chain.ts";
import { Notifier } from "./notifier.ts";

export interface DispatchInput {
  type: TaskRow["type"];
  priority?: TaskRow["priority"];
  description: string;
  branch?: string;
  planDoc?: string;
  parentTask?: string;
  reviewRequired?: boolean;
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
  return s.replace(/\[[0-9;]*[a-zA-Z]/g, "");
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
    });
    if (out.killedByTimeout) return { kind: "timeout" };
    if (out.exitCode !== 0) return { kind: "agent_error", error: out.stderr || `agent exit ${out.exitCode}` };

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
      // `kimi --quiet -w <cwd> [-C] -p <message>`
      // -C continues the most recent session in cwd (used for turn 2+).
      cmd = input.binaries.kimi;
      args = ["--quiet", "-w", cwd];
      if (input.isResume) args.push("-C");
      args.push("-p", input.message);
    } else if (input.agent === "opencode") {
      // `opencode run <message> --dir <cwd> --dangerously-skip-permissions [--continue]`
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

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        // Plugin runs under OpenClaw gateway whose PATH does not include user-local installs.
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
  create(api: OpenClawPluginApi, input: DispatchInput): { ok: boolean; row?: TaskRow; error?: string } {
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
      dispatched_at: null,
      completed_at: null,
    });

    if (startSubStatus === "blocked") {
      api.logger.info(`openclaw-mao: task ${taskId} BLOCKED on parent ${input.parentTask}`);
      return { ok: true, row };
    }

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
    Tracker.update(row.task_id, { sub_status: "running" });
    const outcome = await runTurnLoop(api, row, worktreePath, {
      initialMessage: renderInitialPrompt({ ...row, worktree_path: worktreePath }),
      totalTimeoutMs: timeoutMs,
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

  // User answers a CLARIFY question. The task resumes the multi-turn loop with the user's reply.
  async continue(api: OpenClawPluginApi, taskId: string, userMessage: string): Promise<{ ok: boolean; error?: string }> {
    const row = Tracker.get(taskId);
    if (!row) return { ok: false, error: `task ${taskId} not found` };
    if (row.sub_status !== "awaiting_clarification") {
      return { ok: false, error: `task ${taskId} sub_status=${row.sub_status}, expected awaiting_clarification` };
    }
    if (!row.worktree_path) return { ok: false, error: `task ${taskId} has no worktree_path` };

    const cfg = readConfig(api);
    const followUp = [
      `[USER REPLY to your CLARIFY question]`,
      userMessage,
      "",
      `When you've finished, reply "DONE: <summary>". If you still need clarification, reply "CLARIFY: <question>".`,
    ].join("\n");

    Tracker.update(taskId, { sub_status: "running", clarify_question: null });

    void (async () => {
      const outcome = await runTurnLoop(api, Tracker.get(taskId)!, row.worktree_path!, {
        initialMessage: followUp,
        totalTimeoutMs: 600_000,
      });
      await Dispatcher.handleTurnOutcome(api, Tracker.get(taskId)!, row.worktree_path!, outcome, cfg.verifyMode);
    })().catch((err) => api.logger.error(`openclaw-mao: continue task=${taskId} threw: ${(err as Error).message}`));

    return { ok: true };
  },

  cleanup(api: OpenClawPluginApi, taskId: string): { ok: boolean; removedWorktree: boolean } {
    const cfg = readConfig(api);
    const row = Tracker.get(taskId);
    if (!row) return { ok: false, removedWorktree: false };
    Worktree.remove(cfg.workspaceRoot, row.assignee, row.task_id, row.branch ?? "");
    return { ok: true, removedWorktree: true };
  },
};
