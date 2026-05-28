import type { CanonicalMessage } from "../../model/index.js";
import { TokenBudgetManager, type TokenBudgetSnapshot } from "../budget/TokenBudgetManager.js";

export type AutoCompactionDecision =
  | { type: "skip"; snapshot: TokenBudgetSnapshot }
  | { type: "warn"; snapshot: TokenBudgetSnapshot }
  | { type: "trigger"; snapshot: TokenBudgetSnapshot; reason: "warning_threshold" | "blocking_threshold" };

export type AutoCompactionPolicyOptions = {
  tokenBudget?: TokenBudgetManager;
};

/**
 * Decides when the loop should call `CompactionEngine` proactively. Mirrors
 * legacy `autoCompactIfNeeded` thresholds (warn 80% / block 95%) but pushes
 * the actual model call out to AgentLoop (decision §3.2).
 */
export class AutoCompactionPolicy {
  private readonly tokenBudget: TokenBudgetManager;

  constructor(options: AutoCompactionPolicyOptions = {}) {
    this.tokenBudget = options.tokenBudget ?? new TokenBudgetManager();
  }

  evaluate(messages: CanonicalMessage[], maxContextTokens: number): AutoCompactionDecision {
    const snapshot = this.tokenBudget.evaluate(messages, maxContextTokens);
    if (snapshot.state === "blocking") {
      return { type: "trigger", snapshot, reason: "blocking_threshold" };
    }
    if (snapshot.state === "warning") {
      return { type: "trigger", snapshot, reason: "warning_threshold" };
    }
    return { type: "skip", snapshot };
  }
}
