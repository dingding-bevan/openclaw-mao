import type { DispatchInput } from "./dispatcher.ts";
import type { TaskRow } from "./tracker.ts";

export interface ParseResult {
  ok: boolean;
  input?: DispatchInput;
  error?: string;
}

const VALID_TYPES: ReadonlyArray<TaskRow["type"]> = ["bugfix", "feature", "refactor", "plan-doc", "review"];
const VALID_PRIORITIES: ReadonlyArray<TaskRow["priority"]> = ["low", "medium", "high"];

/**
 * Parse a structured-prefix dispatch line:
 *   TASK:bugfix | <description> | priority:high | branch:agent/foo/x | plan-doc:docs/x.md | parent:<task-id>
 *
 * Only the first two segments (type + description) are required.
 * Returns ok=false with an error string when the input does not look like a TASK: line.
 */
export function parsePrefix(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("TASK:")) {
    return { ok: false, error: "input does not start with TASK:" };
  }
  const segments = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    return { ok: false, error: "expected at least TASK:<type> | <description>" };
  }
  const typeStr = segments[0].slice("TASK:".length).trim();
  if (!VALID_TYPES.includes(typeStr as TaskRow["type"])) {
    return { ok: false, error: `invalid type "${typeStr}", expected one of ${VALID_TYPES.join("|")}` };
  }
  const description = segments[1];

  const out: DispatchInput = {
    type: typeStr as DispatchInput["type"],
    description,
  };

  for (const seg of segments.slice(2)) {
    const colon = seg.indexOf(":");
    if (colon <= 0) continue;
    const key = seg.slice(0, colon).trim().toLowerCase();
    const value = seg.slice(colon + 1).trim();
    if (!value) continue;
    switch (key) {
      case "priority":
        if (!VALID_PRIORITIES.includes(value as TaskRow["priority"])) {
          return { ok: false, error: `invalid priority "${value}"` };
        }
        out.priority = value as DispatchInput["priority"];
        break;
      case "branch":
        out.branch = value;
        break;
      case "plan-doc":
      case "plandoc":
        out.planDoc = value;
        break;
      case "parent":
      case "parent-task":
        out.parentTask = value;
        break;
      case "review":
        out.reviewRequired = value === "1" || value.toLowerCase() === "true";
        break;
      // unknown keys are ignored, not an error — forward-compatible
    }
  }
  return { ok: true, input: out };
}
