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

vi.mock("./tracker.ts", () => ({
  Tracker: {
    get: vi.fn(),
    update: vi.fn(),
    countActive: vi.fn(() => 0),
    list: vi.fn(() => []),
  },
}));

vi.mock("./worktree.ts", () => ({
  Worktree: { create: vi.fn(), remove: vi.fn() },
}));

vi.mock("./verifier.ts", () => ({
  Verifier: { verify: vi.fn() },
}));

vi.mock("./notifier.ts", () => ({
  Notifier: { sendDiscord: vi.fn() },
}));

vi.mock("./chain.ts", () => ({
  Chain: { afterParentTerminal: vi.fn() },
}));

vi.mock("./prompt-templates.ts", () => ({
  buildManualPlan: vi.fn(() => "manual-plan-stub"),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { Dispatcher } from "./dispatcher.ts";
import { Tracker } from "./tracker.ts";
import { Verifier } from "./verifier.ts";
import { Chain } from "./chain.ts";
import type { TaskRow, SubStatus, DispatchMode } from "./tracker.ts";
import type { VerifyMode } from "./verifier.ts";

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
    type: "feature",
    priority: "medium",
    description: "test task description",
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
    created_at: "2026-01-01T00:00:00Z",
    dispatched_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Dispatcher.continue ──────────────────────────────────────────────────

describe("Dispatcher.continue", () => {
  it("returns error when task is not found", async () => {
    vi.mocked(Tracker.get).mockReturnValue(null);

    const result = await Dispatcher.continue(mockApi(), "task-missing", "hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("delegates to _continueClarification when sub_status is awaiting_clarification", async () => {
    const row = makeRow({
      sub_status: "awaiting_clarification",
      clarify_question: "What scope?",
    });
    vi.mocked(Tracker.get).mockReturnValue(row);

    const result = await Dispatcher.continue(mockApi(), row.task_id, "Just the auth module");

    // _continueClarification returns { ok: true } (fire-and-forget runTurnLoop)
    expect(result.ok).toBe(true);
    // Verify it transitioned to running
    expect(Tracker.update).toHaveBeenCalledWith(row.task_id, expect.objectContaining({
      sub_status: "running",
      clarify_question: null,
    }));
  });

  it("delegates to retryFromFailure when sub_status is failed", async () => {
    const row = makeRow({ sub_status: "failed", error: "some error" });
    vi.mocked(Tracker.get).mockReturnValue(row);

    const result = await Dispatcher.continue(mockApi(), row.task_id, "Please retry");

    // retryFromFailure succeeds (guard passes) and returns { ok: true }
    expect(result.ok).toBe(true);
    // Verify state transition: failed → running with incremented retry_run
    expect(Tracker.update).toHaveBeenCalledWith(row.task_id, expect.objectContaining({
      sub_status: "running",
      retry_run: 1,
    }));
  });

  it("returns error for unexpected sub_status", async () => {
    const row = makeRow({ sub_status: "completed" });
    vi.mocked(Tracker.get).mockReturnValue(row);

    const result = await Dispatcher.continue(mockApi(), row.task_id, "hello");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("expected awaiting_clarification or failed");
  });
});

// ─── Dispatcher.retryFromFailure ──────────────────────────────────────────

describe("Dispatcher.retryFromFailure", () => {
  it("rejects when sub_status is not 'failed'", async () => {
    const row = makeRow({ sub_status: "running" });

    const result = await Dispatcher.retryFromFailure(mockApi(), row, "retry please");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("expected failed");
  });

  it("rejects when worktree_path is null", async () => {
    const row = makeRow({ sub_status: "failed", worktree_path: null });

    const result = await Dispatcher.retryFromFailure(mockApi(), row, "retry please");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no worktree_path");
  });

  it("rejects when retry_run budget is exhausted (>= 1)", async () => {
    const row = makeRow({ sub_status: "failed", retry_run: 1, worktree_path: "/tmp/wt" });

    const result = await Dispatcher.retryFromFailure(mockApi(), row, "retry please");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("retry budget exhausted");
  });

  it("transitions to running and increments retry_run on success", async () => {
    const row = makeRow({ sub_status: "failed", retry_run: 0, error: "something broke" });
    vi.mocked(Tracker.get).mockReturnValue(row);

    const result = await Dispatcher.retryFromFailure(mockApi(), row, "please fix and retry");

    expect(result.ok).toBe(true);
    expect(Tracker.update).toHaveBeenCalledWith(
      row.task_id,
      expect.objectContaining({
        sub_status: "running",
        retry_run: 1,
        error: null,
        completed_at: null,
      }),
    );
  });

  it("uses _autoRetryMessage when userMessage is omitted", async () => {
    const row = makeRow({
      sub_status: "failed",
      retry_run: 0,
      error: "verify uncommitted_changes: dirty tree",
    });
    vi.mocked(Tracker.get).mockReturnValue(row);

    // Call without userMessage — retryFromFailure should use _autoRetryMessage internally
    const result = await Dispatcher.retryFromFailure(mockApi(), row);

    expect(result.ok).toBe(true);
  });
});

// ─── Dispatcher.handleTurnOutcome — auto-retry on verify failure ──────────

describe("Dispatcher.handleTurnOutcome verify-failure auto-retry", () => {
  it("auto-retries when verify=uncommitted_changes and retry_run=0", async () => {
    const row = makeRow({
      sub_status: "verifying",
      retry_run: 0,
      branch: "agent/opencode/task-test-001",
    });

    // Tracker.get is called by retryFromFailure to get the fresh row; must satisfy its guards
    const failedRow = { ...row, sub_status: "failed" as SubStatus, error: "verify uncommitted_changes: M src/foo.ts" };
    vi.mocked(Tracker.get).mockReturnValue(failedRow);

    vi.mocked(Verifier.verify).mockReturnValue({
      ok: false,
      reason: "uncommitted_changes",
      detail: "M src/foo.ts",
    });

    await Dispatcher.handleTurnOutcome(
      mockApi(),
      row,
      "/tmp/worktree/task-test-001",
      { kind: "done", finalText: "DONE: implemented feature", turns: 3 },
      "git",
    );

    // Should NOT call afterTerminal (retry path, not hard-fail)
    expect(Chain.afterParentTerminal).not.toHaveBeenCalled();
    // Should have updated to "failed" then retryFromFailure transitions to "running"
    expect(Tracker.update).toHaveBeenCalledWith(
      row.task_id,
      expect.objectContaining({ sub_status: "failed" }),
    );
    expect(Tracker.update).toHaveBeenCalledWith(
      row.task_id,
      expect.objectContaining({ sub_status: "running", retry_run: 1 }),
    );
  });

  it("hard-fails when verify=uncommitted_changes and retry_run >= 1 (no infinite loop)", async () => {
    const row = makeRow({
      sub_status: "verifying",
      retry_run: 1,
      branch: "agent/opencode/task-test-001",
    });

    vi.mocked(Tracker.get).mockReturnValue({ ...row, sub_status: "failed" });

    vi.mocked(Verifier.verify).mockReturnValue({
      ok: false,
      reason: "uncommitted_changes",
      detail: "M src/bar.ts",
    });

    await Dispatcher.handleTurnOutcome(
      mockApi(),
      row,
      "/tmp/worktree/task-test-001",
      { kind: "done", finalText: "DONE: implemented feature", turns: 3 },
      "git",
    );

    // Should call afterTerminal (hard-fail path)
    expect(Chain.afterParentTerminal).toHaveBeenCalled();
    // Should have completed_at (terminal)
    expect(Tracker.update).toHaveBeenCalledWith(
      row.task_id,
      expect.objectContaining({
        sub_status: "failed",
        completed_at: expect.any(String),
      }),
    );
  });

  it("hard-fails on commits_not_pushed (no auto-retry for this reason)", async () => {
    const row = makeRow({
      sub_status: "verifying",
      retry_run: 0,
      branch: "agent/opencode/task-test-001",
    });

    vi.mocked(Tracker.get).mockReturnValue({ ...row, sub_status: "failed" });

    vi.mocked(Verifier.verify).mockReturnValue({
      ok: false,
      reason: "commits_not_pushed",
      detail: "abc123",
    });

    await Dispatcher.handleTurnOutcome(
      mockApi(),
      row,
      "/tmp/worktree/task-test-001",
      { kind: "done", finalText: "DONE: implemented feature", turns: 3 },
      "git",
    );

    // Should call afterTerminal (hard-fail — auto-retry only for uncommitted_changes)
    expect(Chain.afterParentTerminal).toHaveBeenCalled();
    expect(Tracker.update).toHaveBeenCalledWith(
      row.task_id,
      expect.objectContaining({
        sub_status: "failed",
        completed_at: expect.any(String),
      }),
    );
  });
});

// ─── Dispatcher._autoRetryMessage ─────────────────────────────────────────

describe("Dispatcher._autoRetryMessage", () => {
  it("returns commit-reminder for 'uncommitted_changes'", () => {
    const msg = Dispatcher._autoRetryMessage("verify uncommitted_changes: dirty tree");

    expect(msg).toContain("git add");
    expect(msg).toContain("git commit");
    expect(msg).toContain("git push");
    expect(msg).toContain("RETRY");
  });

  it("returns push-reminder for 'commits_not_pushed'", () => {
    const msg = Dispatcher._autoRetryMessage("verify commits_not_pushed: abc123");

    expect(msg).toContain("git push origin HEAD");
    expect(msg).toContain("RETRY");
  });

  it("returns generic retry with truncated error for unknown reason", () => {
    const uniqueMarker = "END_MARKER";
    const longError = "a".repeat(200) + uniqueMarker + "b".repeat(89); // 300 chars total
    const msg = Dispatcher._autoRetryMessage(longError);

    expect(msg).toContain("RETRY");
    expect(msg).toContain("a".repeat(200));
    expect(msg).not.toContain(uniqueMarker); // truncated before the marker
  });
});
