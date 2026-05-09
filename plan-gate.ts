import type { DispatchInput } from "./dispatcher.ts";

export interface PlanGateConfig {
  keywords: string[];
}

const DEFAULT_KEYWORDS = ["重构", "迁移", "替换", "refactor", "migrate", "replace", "框架替换"];

export interface PlanGateVerdict {
  gated: boolean;
  reason?: string;
  matchedKeywords?: string[];
}

/**
 * Decide whether a dispatch should be blocked because it looks like a large refactor
 * without a plan-doc. Triggered by:
 *   - description contains any planGateKeywords (case-insensitive)
 *   - OR type === "refactor"
 *
 * If gated and `--plan-doc` is missing, dispatch must be refused with a helpful hint.
 */
export const PlanGate = {
  check(input: DispatchInput, cfg?: PlanGateConfig): PlanGateVerdict {
    const keywords = (cfg?.keywords && cfg.keywords.length > 0 ? cfg.keywords : DEFAULT_KEYWORDS).map((k) =>
      k.toLowerCase(),
    );
    const desc = input.description.toLowerCase();
    const matched = keywords.filter((k) => desc.includes(k));

    const triggeredByKeyword = matched.length > 0;
    const triggeredByType = input.type === "refactor";
    if (!triggeredByKeyword && !triggeredByType) {
      return { gated: false };
    }
    if (input.planDoc && input.planDoc.trim().length > 0) {
      return { gated: false }; // plan-doc supplied, gate satisfied
    }
    const reason = triggeredByType
      ? `type=refactor requires --plan-doc`
      : `description matched plan-mode keywords (${matched.join(", ")}) and --plan-doc missing`;
    return { gated: true, reason, matchedKeywords: matched };
  },
};
