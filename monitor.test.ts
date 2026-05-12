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
import { readdirSync, statSync } from "node:fs";
import type { TaskRow, SubStatus, DispatchMode } from "./tracker.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "task-test-001",
    type: "feature",
    priority: "medium",
    description: "test task",
    assignee: "opencode",
    branch: "agent/opencode/task-test-001",
    worktree_path: "/tmp/worktree/task-test-001",
    sub_status: "running" as SubStatus,
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
    created_at: "2026-01-01T00:00:00Z",
    dispatched_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function mockApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: {},
  } as any;
}

const BASE_OPTS = {
  stuckHeartbeatMin: 9999,
  verifyingTimeoutMin: 9999,
};

/** Find the Tracker.update call that set loop_health on our test task. */
function findHealthUpdate() {
  const calls = (Tracker.update as ReturnType<typeof vi.fn>).mock.calls;
  for (const c of calls) {
    if (c[1] && typeof c[1] === "object" && "loop_health" in c[1]) {
      return c[1] as { loop_health: string; step_count: number | null };
    }
  }
  return null;
}

/** Wire up fs/child_process mocks so probeOpencodeStepCount returns `steps`. */
function setupStepMocks(dispatchedAt: Date, steps: number) {
  (readdirSync as ReturnType<typeof vi.fn>).mockImplementation(
    (dir: string) => {
      if (typeof dir === "string" && dir.includes("opencode/log")) {
        return ["session.log"];
      }
      return [];
    },
  );
  (statSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    if (typeof path === "string" && path.endsWith("session.log")) {
      return { mtimeMs: dispatchedAt.getTime() + 60_000 };
    }
    return { mtimeMs: Date.now() };
  });
  (spawnSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
    if (cmd === "grep") return { status: 0, stdout: `${steps}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("probeLoopHealth (via monitor)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  // ── 1. Warmup ─────────────────────────────────────────────────────────

  it("returns unknown during warmup (task dispatched < 3 min ago)", () => {
    const row = makeRow({
      dispatched_at: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    const result = Monitor.tick(mockApi(), BASE_OPTS);

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("unknown");
    expect(result.degraded_loops).toBeUndefined();
  });

  // ── 2. Degraded: step_count > 1.5x threshold ─────────────────────────

  it("returns degraded when step_count > 1.5x threshold", () => {
    const dispatchedAt = new Date(Date.now() - 30 * 60_000);
    const row = makeRow({ dispatched_at: dispatchedAt.toISOString() });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // 121 > 80 * 1.5 (120) → degraded
    setupStepMocks(dispatchedAt, 121);

    const result = Monitor.tick(mockApi(), BASE_OPTS);

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("degraded");
    expect(health!.step_count).toBe(121);
    expect(result.degraded_loops).toHaveLength(1);
  });

  // ── 3. Degraded: dual signal (step_count >= threshold AND worktree idle)

  it("returns degraded when step_count >= threshold AND worktree idle", () => {
    const dispatchedAt = new Date(Date.now() - 30 * 60_000);
    const row = makeRow({ dispatched_at: dispatchedAt.toISOString() });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // step count 85 >= 80 threshold
    (readdirSync as ReturnType<typeof vi.fn>).mockImplementation(
      (dir: string, opts?: any) => {
        if (typeof dir === "string" && dir.includes("opencode/log")) {
          return ["session.log"];
        }
        // worktree: one stale file
        if (opts?.withFileTypes && typeof dir === "string" && dir.includes("worktree")) {
          return [makeDirent("changed.ts", false)];
        }
        return [];
      },
    );
    (statSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith("session.log")) {
        return { mtimeMs: dispatchedAt.getTime() + 60_000 };
      }
      // worktree file 15 min stale (> 10 min default threshold)
      if (typeof path === "string" && path.endsWith("changed.ts")) {
        return { mtimeMs: Date.now() - 15 * 60_000 };
      }
      return { mtimeMs: Date.now() };
    });
    (spawnSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) => {
      if (cmd === "grep") return { status: 0, stdout: "85\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });

    const result = Monitor.tick(mockApi(), BASE_OPTS);

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("degraded");
    expect(health!.step_count).toBe(85);
    expect(result.degraded_loops).toHaveLength(1);
  });

  // ── 4. Healthy ────────────────────────────────────────────────────────

  it("returns healthy when step_count below threshold", () => {
    const dispatchedAt = new Date(Date.now() - 30 * 60_000);
    const row = makeRow({ dispatched_at: dispatchedAt.toISOString() });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // 30 < 80 → healthy
    setupStepMocks(dispatchedAt, 30);

    const result = Monitor.tick(mockApi(), BASE_OPTS);

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("healthy");
    expect(health!.step_count).toBe(30);
    expect(result.degraded_loops).toBeUndefined();
  });

  // ── 5. Kimi fallback ──────────────────────────────────────────────────

  it("kimi assignee: returns unknown when step_count unavailable", () => {
    const dispatchedAt = new Date(Date.now() - 30 * 60_000);
    const row = makeRow({
      assignee: "kimi",
      dispatched_at: dispatchedAt.toISOString(),
    });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // probeOpencodeStepCount returns null for non-opencode assignees.
    // No worktree files → mtime = null → "step_count unavailable"
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = Monitor.tick(mockApi(), BASE_OPTS);

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("unknown");
    expect(result.degraded_loops).toBeUndefined();
  });

  // ── 6. Custom thresholds ──────────────────────────────────────────────

  it("respects custom thresholds from opts", () => {
    const dispatchedAt = new Date(Date.now() - 30 * 60_000);
    const row = makeRow({ dispatched_at: dispatchedAt.toISOString() });
    (Tracker.list as ReturnType<typeof vi.fn>).mockReturnValue([row]);

    // 50 steps with custom threshold 30 → 50 >= 30*1.5 (45) → degraded
    setupStepMocks(dispatchedAt, 50);

    const result = Monitor.tick(mockApi(), {
      ...BASE_OPTS,
      unhealthyStepThreshold: 30,
    });

    const health = findHealthUpdate();
    expect(health).not.toBeNull();
    expect(health!.loop_health).toBe("degraded");
    expect(health!.step_count).toBe(50);
    expect(result.degraded_loops).toHaveLength(1);
  });
});
