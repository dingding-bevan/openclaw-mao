import type { TaskRow } from "./tracker.ts";

export interface ManualPlan {
  ssh_command: string;
  recommended_agent: string;
  prompt_to_paste: string;
  next_step_hint: string;
}

export interface ManualPlanInput {
  taskId: string;
  type: TaskRow["type"];
  description: string;
  branch: string;
  worktreePath: string;
  planDoc?: string | null;
  vpsHost?: string;       // user@host for ssh; defaults to admin@47.85.199.78
}

const DEFAULT_VPS = "admin@47.85.199.78";

function header(input: ManualPlanInput): string {
  const lines = [
    `[MAO TASK ${input.taskId}]`,
    `Type: ${input.type}`,
    `Branch: ${input.branch}`,
    `Working directory: ${input.worktreePath}`,
  ];
  if (input.planDoc) lines.push(`Plan doc: ${input.planDoc}`);
  return lines.join("\n");
}

function footer(): string {
  return [
    "",
    "Workflow:",
    "  1. Plan → Design → Code (one file at a time)",
    "  2. Verify after each change (run tests / typecheck if applicable)",
    "  3. git add <changed files>",
    "  4. git commit -m \"<conventional message>\"",
    "  5. git push origin HEAD",
    "",
    "When you finish (or want mao to detect completion), make sure:",
    "  - working tree is clean (no uncommitted changes)",
    "  - your branch is fully pushed to origin",
    "",
    "mao monitor (cron, every 5 min) auto-detects completion and moves the task into",
    "verifying → reviewing/completed. Run `openclaw mao monitor-tick` on the host to",
    "trigger detection immediately instead of waiting for cron.",
  ].join("\n");
}

function planDocPrompt(input: ManualPlanInput): string {
  return [
    header(input),
    "",
    `Task: ${input.description}`,
    "",
    "Output requirements:",
    "  - File: docs/<feature-name>-impl-plan.md  (you choose <feature-name>; kebab-case)",
    "  - Sections: Motivation / Data Model / Flow / MVP Boundaries / Open Questions / Test Plan",
    "  - 200-400 lines, decision-driven (not exhaustive)",
    "  - Reference existing antalpha-agent patterns where relevant (read src/ first)",
    "  - Open Questions must include Lean toward / Proposal / Mitigation — no bare TBDs",
    "",
    "Do NOT write code in this task. Only the plan document.",
    "Commit message: docs: <feature-name> impl plan (MVP)",
    footer(),
  ].join("\n");
}

function featurePrompt(input: ManualPlanInput): string {
  return [
    header(input),
    "",
    `Task: ${input.description}`,
    "",
    "Build a feature implementation. If the description is large or the change spans 5+",
    "files, stop and ask for a plan-doc first (reply with CLARIFY: prefix).",
    "",
    "Constraints:",
    "  - Surgical execution: one file at a time, verify after each",
    "  - No 'TBD' / 'TODO' in deliverable code",
    "  - Tests for new behavior; do not skip without explicit reason",
    "",
    "Commit message: feat: <one-line summary>",
    footer(),
  ].join("\n");
}

function refactorPrompt(input: ManualPlanInput): string {
  const planDocLine = input.planDoc
    ? `Plan doc REQUIRED — read ${input.planDoc} first. Stick to its contract.`
    : `WARNING: no --plan-doc supplied. mao plan-gate would normally block this. Please confirm refactor scope is small enough not to need a plan, OR ask user to dispatch a plan-doc task first.`;
  return [
    header(input),
    "",
    `Task: ${input.description}`,
    "",
    planDocLine,
    "",
    "Constraints:",
    "  - Refactor only — preserve external behavior (API, side effects, performance)",
    "  - Tests must keep passing at every commit (commit per logical step, not as one big bang)",
    "  - If you discover a real bug along the way, STOP and ask the user (CLARIFY:)",
    "",
    "Commit message: refactor: <one-line summary>",
    footer(),
  ].join("\n");
}

function bugfixPrompt(input: ManualPlanInput): string {
  return [
    header(input),
    "",
    `Task: ${input.description}`,
    "",
    "Constraints:",
    "  - Root-cause first. No fixes without investigation.",
    "  - Reproduce before fix. Add a regression test if practical.",
    "  - Keep change minimal — single concept per commit.",
    "",
    "Commit message: fix: <one-line summary>",
    footer(),
  ].join("\n");
}

function reviewPrompt(input: ManualPlanInput): string {
  return [
    header(input),
    "",
    `Review task: ${input.description}`,
    "",
    "Output requirements:",
    "  - Add a markdown report to docs/reviews/<topic>-<YYYY-MM-DD>.md",
    "  - Sections: Scope / Findings (categorized: blocking / non-blocking / nits) / Recommendation",
    "  - For each blocking finding, propose a concrete fix",
    "",
    "Commit message: docs: <topic> review notes",
    footer(),
  ].join("\n");
}

function buildPrompt(input: ManualPlanInput): string {
  switch (input.type) {
    case "plan-doc": return planDocPrompt(input);
    case "feature":  return featurePrompt(input);
    case "refactor": return refactorPrompt(input);
    case "bugfix":   return bugfixPrompt(input);
    case "review":   return reviewPrompt(input);
  }
}

const RECOMMENDED_AGENT_BY_TYPE: Record<TaskRow["type"], { tui: "kimi" | "opencode"; tab_to: string }> = {
  bugfix:     { tui: "kimi",     tab_to: "Kimi (no TAB needed — kimi has a single agent profile)" },
  feature:    { tui: "opencode", tab_to: "Hephaestus (Code generation SOTA — GLM-5.1)" },
  refactor:   { tui: "opencode", tab_to: "Deep (8h continuous autonomous — GLM-5.1)" },
  "plan-doc": { tui: "opencode", tab_to: "Prometheus (Plan Builder — K2.6, 4000-step coordination)" },
  review:     { tui: "opencode", tab_to: "Momus (Review/quality — Qwen3.6+, MCPMark 48.2%)" },
};

export function buildManualPlan(input: ManualPlanInput): ManualPlan {
  const host = input.vpsHost ?? DEFAULT_VPS;
  const rec = RECOMMENDED_AGENT_BY_TYPE[input.type];
  const tuiCmd = rec.tui === "kimi" ? "kimi" : "opencode";
  const sshCmd = `ssh -t ${host} "cd ${input.worktreePath} && ${tuiCmd}"`;
  return {
    ssh_command: sshCmd,
    recommended_agent: rec.tab_to,
    prompt_to_paste: buildPrompt(input),
    next_step_hint:
      rec.tui === "opencode"
        ? "Inside opencode tui, press TAB to switch the active agent profile."
        : "Inside kimi tui, paste the prompt directly — kimi uses your ~/.kimi/AGENTS.md as the working contract.",
  };
}
