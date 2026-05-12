import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies BEFORE importing the module under test ──────────────

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock("./tracker.ts", () => ({
  Tracker: {
    get: vi.fn(),
    update: vi.fn(),
    countActive: vi.fn(() => 0),
    list: vi.fn(() => []),
  },
}));

vi.mock("./notifier.ts", () => ({
  Notifier: { sendDiscord: vi.fn() },
}));

vi.mock("./verifier.ts", () => ({
  Verifier: { verify: vi.fn() },
}));

vi.mock("./worktree.ts", () => ({
  Worktree: { create: vi.fn(), remove: vi.fn() },
}));

vi.mock("./dispatcher.ts", () => ({
  extractSessionId: vi.fn(() => null),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { Monitor } from "./monitor.ts";
import { Tracker } from "./tracker.ts";
import { spawnSync } from "node:child_process";
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
    task_id: "task-tmux-001",
    type: "feature",
    priority: "medium",
    description: "test task",
    assignee: "opencode",
    branch: "agent/opencode/task-tmux-001",
    worktree_path: "/tmp/worktree/task-tmux-001",
    sub_status: "completed" as SubStatus,
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
    tmux_session_name: "mao-tmux00",
    created_at: "2026-01-01T00:00:00Z",
    dispatched_at: new Date(Date.now() - 120 * 60_000).toISOString(),
    completed_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    ...overrides,
  };
}

const BASE_OPTS = {
  stuckHeartbeatMin: 9999,
  verifyingTimeoutMin: 9999,
};

/** Check if spawnSync was called with tmux kill-session for a specific session. */
function wasKillSessionCalled(sessionName: string): boolean {
  return (spawnSync as ReturnType<typeof vi.fn>).mock.calls.some(
    (c: any[]) => c[0] === "tmux" && c[1]?.includes("kill-session") && c[1]?.includes(sessionName),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Monitor tmux session sweep (step 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it("kills terminal-state session older than retention", () => {
    const row = makeRow({
      sub_status: "completed",
      tmux_session_name: "mao-old123",
      completed_at: new Date(Date.now() - 90 * 60_000).toISOString(), // 90 min ago
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // tmux has-session succeeds → kill-session succeeds
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0, stdout: "", stderr: "" });

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    expect(wasKillSessionCalled("mao-old123")).toBe(true);
  });

  it("skips session younger than retention", () => {
    const row = makeRow({
      sub_status: "completed",
      tmux_session_name: "mao-young1",
      completed_at: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    expect(wasKillSessionCalled("mao-young1")).toBe(false);
  });

  it("skips session already gone (has-session fails)", () => {
    const row = makeRow({
      sub_status: "completed",
      tmux_session_name: "mao-gone01",
      completed_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // has-session returns non-zero (session doesn't exist)
    (spawnSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    // kill-session should NOT have been called (session already gone)
    const killCalls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === "tmux" && c[1]?.includes("kill-session"),
    );
    expect(killCalls).toHaveLength(0);
  });

  it("skips task without tmux_session_name", () => {
    const row = makeRow({
      sub_status: "completed",
      tmux_session_name: null,
      completed_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    const tmuxCalls = (spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === "tmux",
    );
    // No tmux calls for this task (filtered out before has-session check)
    expect(tmuxCalls).toHaveLength(0);
  });

  it("skips non-terminal sub_status", () => {
    const row = makeRow({
      sub_status: "running",
      tmux_session_name: "mao-run001",
      completed_at: null,
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    expect(wasKillSessionCalled("mao-run001")).toBe(false);
  });

  it("uses default retention of 60 minutes when not specified", () => {
    const row = makeRow({
      sub_status: "failed",
      tmux_session_name: "mao-fail01",
      completed_at: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 min ago
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0, stdout: "", stderr: "" });

    // No tmuxRetentionMin specified → default 60
    Monitor.tick(mockApi(), BASE_OPTS);

    expect(wasKillSessionCalled("mao-fail01")).toBe(true);
  });

  it("kills multiple expired sessions", () => {
    const rows = [
      makeRow({
        task_id: "task-a",
        sub_status: "completed",
        tmux_session_name: "mao-sess-a",
        completed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
      }),
      makeRow({
        task_id: "task-b",
        sub_status: "failed",
        tmux_session_name: "mao-sess-b",
        completed_at: new Date(Date.now() - 100 * 60_000).toISOString(),
      }),
    ];
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue(rows);

    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0, stdout: "", stderr: "" });

    Monitor.tick(mockApi(), { ...BASE_OPTS, tmuxRetentionMin: 60 });

    expect(wasKillSessionCalled("mao-sess-a")).toBe(true);
    expect(wasKillSessionCalled("mao-sess-b")).toBe(true);
  });
});
