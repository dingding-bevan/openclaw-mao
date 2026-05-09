import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";

const MAX_CHAIN_DEPTH = 5;

export interface BlockVerdict {
  blocked: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Decide whether a child task should be admitted to the queue immediately or held in BLOCKED.
 * Caller passes a fresh DispatchInput before Tracker.insert.
 */
export const Chain = {
  shouldBlockOnInsert(parentTaskId: string | undefined): BlockVerdict {
    if (!parentTaskId) return { blocked: false };
    const parent = Tracker.get(parentTaskId);
    if (!parent) {
      return { blocked: true, reason: "unknown_parent", detail: `parent task ${parentTaskId} not found` };
    }
    if (parent.sub_status === "completed" || parent.sub_status === "pushed") {
      return { blocked: false };
    }
    if (parent.sub_status === "failed" || parent.sub_status === "cancelled") {
      return { blocked: true, reason: "parent_terminal_failed", detail: `parent ${parentTaskId} is ${parent.sub_status}` };
    }
    return { blocked: true, reason: "parent_not_done", detail: `parent ${parentTaskId} is ${parent.sub_status}` };
  },

  /**
   * Cycle/length detection — must run before insert.
   *  - reject if proposed parent points to ancestor that includes self (only relevant for re-runs/edits)
   *  - reject if chain depth >= MAX_CHAIN_DEPTH
   */
  validateAncestry(parentTaskId: string | undefined): { ok: boolean; error?: string } {
    if (!parentTaskId) return { ok: true };
    let cursor: string | undefined = parentTaskId;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor) {
      if (seen.has(cursor)) {
        return { ok: false, error: `cycle detected at ${cursor}` };
      }
      seen.add(cursor);
      depth += 1;
      if (depth >= MAX_CHAIN_DEPTH) {
        return { ok: false, error: `chain depth exceeds ${MAX_CHAIN_DEPTH}` };
      }
      const node: TaskRow | null = Tracker.get(cursor);
      cursor = node?.openclaw_parent_task_id ?? undefined;
    }
    return { ok: true };
  },

  /**
   * Called from dispatcher when a parent task reaches a terminal sub_status.
   * - parent pushed/completed → unblock direct children: BLOCKED → pending
   * - parent failed/cancelled → cascade-cancel all BLOCKED descendants
   */
  afterParentTerminal(api: OpenClawPluginApi, parent: TaskRow): TaskRow[] {
    const isSuccess = parent.sub_status === "pushed" || parent.sub_status === "completed";
    const isFail = parent.sub_status === "failed" || parent.sub_status === "cancelled";
    if (!isSuccess && !isFail) return [];

    const allBlocked = Tracker.list({ sub_status: "blocked" });
    const direct = allBlocked.filter((t) => t.openclaw_parent_task_id === parent.task_id);
    const affected: TaskRow[] = [];

    for (const child of direct) {
      if (isSuccess) {
        Tracker.update(child.task_id, { sub_status: "pending" });
        api.logger.info(`openclaw-mao: chain unblocked child=${child.task_id} (parent ${parent.task_id} ${parent.sub_status})`);
      } else {
        Tracker.update(child.task_id, {
          sub_status: "cancelled",
          error: `parent ${parent.task_id} terminal-failed: ${parent.sub_status}`,
          completed_at: new Date().toISOString(),
        });
        api.logger.warn(`openclaw-mao: chain cascade-cancelled child=${child.task_id}`);
      }
      affected.push(Tracker.get(child.task_id)!);

      if (isFail) {
        // Recursively cascade-cancel grandchildren (their parent we just cancelled)
        const cascaded = Chain.afterParentTerminal(api, Tracker.get(child.task_id)!);
        affected.push(...cascaded);
      }
    }
    return affected;
  },
};
