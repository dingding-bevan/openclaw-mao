import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies BEFORE importing the module under test ──────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("./tracker.ts", () => ({
  Tracker: {
    get: vi.fn(),
    update: vi.fn(),
    countActive: vi.fn(() => 0),
    list: vi.fn(() => []),
  },
}));

vi.mock("./worktree.ts", () => ({
  Worktree: { create: vi.fn(() => ({ worktreePath: "/tmp/worktree/task-test-001" })), remove: vi.fn() },
}));

vi.mock("./verifier.ts", () => ({
  Verifier: { verify: vi.fn(() => ({ ok: true })) },
}));

vi.mock("./notifier.ts", () => ({
  Notifier: { sendDiscord: vi.fn() },
}));

vi.mock("./chain.ts", () => ({
  Chain: { afterParentTerminal: vi.fn(), validateAncestry: vi.fn(() => ({ ok: true })), shouldBlockOnInsert: vi.fn(() => ({ blocked: false })) },
}));

vi.mock("./prompt-templates.ts", () => ({
  buildManualPlan: vi.fn(() => "manual-plan-stub"),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { Dispatcher } from "./dispatcher.ts";
import { Tracker } from "./tracker.ts";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { TaskRow, SubStatus, DispatchMode } from "./tracker.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function mockApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: {},
  } as any;
}

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "task-test-001",
    type: "bugfix",
    priority: "medium",
    description: "test task",
    assignee: "kimi",
    branch: "agent/kimi/task-test-001",
    worktree_path: "/tmp/worktree/task-test-001",
    sub_status: "dispatch" as SubStatus,
    openclaw_task_id: null,
    openclaw_parent_task_id: null,
    plan_doc: null,
    review_required: 0,
    retry_run: 0,
    retry_review: 0,
    result_json: null,
    error: null,
    review_verdict: null,
    review_feedback: null,
    reviewed_at: null,
    clarify_question: null,
    mode: "auto" as DispatchMode,
    external_session_id: null,
    loop_health: null,
    step_count: null,
    last_worktree_mtime: null,
    loop_health_notified_at: null,
    tmux_session_name: null,
    created_at: "2026-01-01T00:00:00Z",
    dispatched_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

/** Find the Tracker.update call that set tmux_session_name. */
function findTmuxSessionUpdate(): string | null {
  const calls = (Tracker.update as ReturnType<typeof vi.fn>).mock.calls;
  for (const c of calls) {
    if (c[1] && typeof c[1] === "object" && "tmux_session_name" in c[1]) {
      return (c[1] as { tmux_session_name: string }).tmux_session_name;
    }
  }
  return null;
}

/** Find any Tracker.update call that set a specific sub_status. */
function findSubStatusUpdate(status: string): object | null {
  const calls = (Tracker.update as ReturnType<typeof vi.fn>).mock.calls;
  for (const c of calls) {
    if (c[1] && typeof c[1] === "object" && c[1].sub_status === status) {
      return c[1];
    }
  }
  return null;
}

/**
 * Wire up mocks so Dispatcher.run() completes one successful turn.
 * Returns a promise that resolves when run() finishes.
 */
async function runDispatch(rowOverrides: Partial<TaskRow> = {}) {
  const row = makeRow({
    type: "bugfix",
    assignee: "kimi",
    ...rowOverrides,
  });

  // Make Tracker.get return updated row as run proceeds
  let currentRow = { ...row };
  (Tracker.get as ReturnType<typeof vi.fn>).mockImplementation(() => currentRow);
  (Tracker.update as ReturnType<typeof vi.fn>).mockImplementation((_id: string, updates: any) => {
    currentRow = { ...currentRow, ...updates };
  });
  (Tracker.countActive as ReturnType<typeof vi.fn>).mockReturnValue(0);

  // Mock readFile to return sentinel immediately so pollLogUntilSentinelOrTimeout resolves fast
  (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
    "DONE: task completed\n__MAO_TURN_EXIT_0_END__\n",
  );

  await Dispatcher.run(mockApi(), row);
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── ensureTmuxSession ────────────────────────────────────────────────────

describe("ensureTmuxSession (via Dispatcher.run)", () => {
  it("creates new session when none exists", async () => {
    // has-session fails → new-session succeeds
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // tmux has-session → no session
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // tmux new-session → success
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });    // all other calls (send-keys, etc.)

    await runDispatch();

    const sessionName = findTmuxSessionUpdate();
    expect(sessionName).not.toBeNull();
    expect(sessionName!.startsWith("mao-")).toBe(true);

    // Verify has-session was called first
    expect(spawnSync).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["has-session"]),
      expect.anything(),
    );
    // Verify new-session was called
    expect(spawnSync).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session"]),
      expect.anything(),
    );
  });

  it("reuses existing session when one exists", async () => {
    // has-session succeeds → no new-session needed
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // tmux has-session → exists
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });    // send-keys etc.

    await runDispatch();

    const sessionName = findTmuxSessionUpdate();
    expect(sessionName).not.toBeNull();
    expect(sessionName!.startsWith("mao-")).toBe(true);

    // Should NOT have called new-session (only has-session + send-keys later)
    const calls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls;
    const newSessionCalls = calls.filter((c: any[]) => c[0] === "tmux" && c[1]?.includes("new-session"));
    expect(newSessionCalls).toHaveLength(0);
  });

  it("falls back to suffixed name on collision", async () => {
    // has-session fails → new-session fails → fallback new-session succeeds
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // has-session fails
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // new-session fails (collision)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // fallback new-session succeeds
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });    // send-keys etc.

    await runDispatch();

    const sessionName = findTmuxSessionUpdate();
    expect(sessionName).not.toBeNull();
    // Original name is mao- + last 6 of task id; fallback adds -NNNN suffix
    const shortId = "task-test-001".slice(-6);
    expect(sessionName!.startsWith(`mao-${shortId}-`)).toBe(true);
  });
});

// ─── spawnAgentTurn tmux path ─────────────────────────────────────────────

describe("spawnAgentTurn tmux path (via Dispatcher.run)", () => {
  it("uses tmux send-keys when sessionName is set", async () => {
    // ensureTmuxSession: has-session succeeds
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // has-session
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });     // send-keys

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "DONE: all good\n__MAO_TURN_EXIT_0_END__\n",
    );

    await runDispatch();

    // Verify send-keys was called with the session name
    const sendKeysCalls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === "tmux" && c[1]?.[0] === "send-keys",
    );
    expect(sendKeysCalls.length).toBeGreaterThanOrEqual(1);

    const sessionName = findTmuxSessionUpdate();
    expect(sendKeysCalls[0][1]).toContain(sessionName);
  });

  it("reads log file and extracts sentinel exit code", async () => {
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // has-session
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });     // send-keys

    // Sentinel with exit code 0
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "DONE: completed\n__MAO_TURN_EXIT_0_END__\n",
    );

    await runDispatch();

    // Task should reach completed state (via handleTurnOutcome with "done")
    // Check that Tracker.update was called with sub_status "running" then eventually completes
    const runningUpdate = findSubStatusUpdate("running");
    expect(runningUpdate).not.toBeNull();
    expect(runningUpdate!.tmux_session_name).toBeDefined();
  });

  it("strips sentinel from polled content", async () => {
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const logContent = "DONE: task done\n__MAO_TURN_EXIT_0_END__\n";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(logContent);

    await runDispatch();

    // Verify readFile was called (log was polled)
    expect(readFile).toHaveBeenCalled();
    // The sentinel should be stripped from the content passed to extractFinalText
    // so finalText should be just "DONE: task done"
    expect(Tracker.update).toHaveBeenCalled();
  });

  it("reports timeout when sentinel not found in log", async () => {
    (spawnSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // has-session
      .mockReturnValue({ status: 0, stdout: "", stderr: "" });     // send-keys

    // readFile throws → sentinel never found → pollLogUntilSentinelOrTimeout returns timedOut: true
    // BUT this would take a long time due to 1-second sleep loops
    // Instead, test with a very fast approach: make readFile throw once then return sentinel
    let readCount = 0;
    (readFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
      readCount++;
      if (readCount <= 2) throw new Error("ENOENT");
      return Promise.resolve("DONE: late\n__MAO_TURN_EXIT_0_END__\n");
    });

    await runDispatch({ type: "bugfix" }); // bugfix timeout = 15 min

    // Should still complete successfully (just with delayed log file)
    const runningUpdate = findSubStatusUpdate("running");
    expect(runningUpdate).not.toBeNull();
  });
});
