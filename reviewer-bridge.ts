import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Tracker, type TaskRow } from "./tracker.ts";

export type Verdict = "pass" | "fail" | "needs-clarification";

export interface ReviewBundle {
  ok: boolean;
  task: TaskRow | null;
  diff: string | null;
  diff_stat: string | null;
  plan_doc: { path: string; content: string } | null;
  agent_result: unknown | null;
  hints: { contract_checks: string[] };
  error?: string;
}

const CONTRACT_CHECKS = [
  "contract_satisfied: do the changes meet the explicit task description?",
  "di_wiring_correct: any new injected deps wired correctly (real value imports, not type-only)?",
  "edge_cases_covered: are obvious edge cases handled (null, empty, error path)?",
  "test_validates_contract_not_just_state: do tests assert behaviour or just internal state?",
  "no_pseudo_implementation: any function that says it does X actually does X?",
];

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const ReviewerBridge = {
  prepareBundle(api: OpenClawPluginApi, taskId: string): ReviewBundle {
    const task = Tracker.get(taskId);
    if (!task) {
      return {
        ok: false,
        task: null,
        diff: null,
        diff_stat: null,
        plan_doc: null,
        agent_result: null,
        hints: { contract_checks: CONTRACT_CHECKS },
        error: `task ${taskId} not found`,
      };
    }
    if (task.sub_status !== "reviewing" && task.sub_status !== "pushed") {
      // Bundle can be inspected at any time, but flag if task isn't ready for review.
      api.logger.warn(`openclaw-mao: review-bundle for task ${taskId} sub_status=${task.sub_status} (expected reviewing|pushed)`);
    }

    let diff: string | null = null;
    let diffStat: string | null = null;
    if (task.worktree_path && task.branch && existsSync(task.worktree_path)) {
      const baseRef = gitSync(task.worktree_path, ["rev-parse", "--verify", "origin/main"]).ok
        ? "origin/main"
        : "main";
      const d = gitSync(task.worktree_path, ["diff", `${baseRef}...HEAD`]);
      const s = gitSync(task.worktree_path, ["diff", "--stat", `${baseRef}...HEAD`]);
      if (d.ok) diff = d.stdout;
      if (s.ok) diffStat = s.stdout;
    }

    let planDoc: { path: string; content: string } | null = null;
    if (task.plan_doc && existsSync(task.plan_doc)) {
      try {
        planDoc = { path: task.plan_doc, content: readFileSync(task.plan_doc, "utf8") };
      } catch {
        planDoc = null;
      }
    }

    let agentResult: unknown | null = null;
    if (task.result_json) {
      try {
        agentResult = JSON.parse(task.result_json);
      } catch {
        agentResult = task.result_json;
      }
    }

    return {
      ok: true,
      task,
      diff,
      diff_stat: diffStat,
      plan_doc: planDoc,
      agent_result: agentResult,
      hints: { contract_checks: CONTRACT_CHECKS },
    };
  },

  recordVerdict(
    api: OpenClawPluginApi,
    taskId: string,
    verdict: Verdict,
    feedback: string | undefined,
  ): { ok: boolean; new_sub_status?: TaskRow["sub_status"]; error?: string; retried?: boolean } {
    const task = Tracker.get(taskId);
    if (!task) return { ok: false, error: `task ${taskId} not found` };
    if (task.sub_status !== "reviewing") {
      return { ok: false, error: `task ${taskId} sub_status=${task.sub_status}, expected reviewing` };
    }

    Tracker.update(taskId, {
      review_verdict: verdict,
      review_feedback: feedback ?? null,
      reviewed_at: new Date().toISOString(),
    });

    if (verdict === "pass") {
      Tracker.update(taskId, { sub_status: "completed", completed_at: new Date().toISOString() });
      api.logger.info(`openclaw-mao: review-result task=${taskId} PASS → completed`);
      return { ok: true, new_sub_status: "completed" };
    }

    if (verdict === "needs-clarification") {
      Tracker.update(taskId, {
        sub_status: "failed",
        completed_at: new Date().toISOString(),
        error: `review needs-clarification: ${feedback ?? "(no feedback)"}`,
      });
      api.logger.warn(`openclaw-mao: review-result task=${taskId} NEEDS-CLARIFICATION → failed`);
      return { ok: true, new_sub_status: "failed" };
    }

    // verdict === "fail"
    if (task.retry_review >= 1) {
      Tracker.update(taskId, {
        sub_status: "failed",
        completed_at: new Date().toISOString(),
        error: `review fail (retry exhausted): ${feedback ?? "(no feedback)"}`,
      });
      api.logger.warn(`openclaw-mao: review-result task=${taskId} FAIL (retry exhausted) → failed`);
      return { ok: true, new_sub_status: "failed" };
    }

    // retry budget available: bump counter, store feedback, dispatcher will resume
    Tracker.update(taskId, {
      retry_review: task.retry_review + 1,
      sub_status: "running",
    });
    api.logger.info(`openclaw-mao: review-result task=${taskId} FAIL → retry (review feedback feed-back)`);
    return { ok: true, new_sub_status: "running", retried: true };
  },
};
