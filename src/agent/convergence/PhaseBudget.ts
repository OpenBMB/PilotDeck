export type PhaseBudgetPhase = "sources" | "matrices" | "issues" | "authorities" | "coverage" | "complete" | "incomplete";

export type PhaseBudgetConfig = {
  enabled: true;
  finalizationReserveMs: number;
  phaseBudgetsMs?: Partial<Record<PhaseBudgetPhase, number>>;
};

export type PhaseBudgetDecision = {
  phase: PhaseBudgetPhase;
  allowed: boolean;
  finishFirst: boolean;
  remainingMs: number;
  reserveMs: number;
  phaseBudgetMs?: number;
  reason: "within_budget" | "finalization_reserve" | "deadline_expired" | "phase_budget_exhausted";
};

/**
 * Domain-neutral deadline policy. It does not stop a turn by itself; callers
 * use the decision to stop opening new work and preserve finalization time.
 */
export class PhaseBudgetController {
  constructor(
    private readonly config: PhaseBudgetConfig | undefined,
    private readonly deadlineAtMs?: number,
    private readonly startedAtMs: number = Date.now(),
  ) {}

  evaluate(phase: string, nowMs: number = Date.now()): PhaseBudgetDecision | undefined {
    if (!this.config?.enabled || this.deadlineAtMs === undefined) return undefined;
    const normalizedPhase = normalizePhase(phase);
    const remainingMs = Math.max(0, this.deadlineAtMs - nowMs);
    const reserveMs = Math.max(0, this.config.finalizationReserveMs);
    const phaseBudgetMs = this.config.phaseBudgetsMs?.[normalizedPhase];
    const elapsedMs = Math.max(0, nowMs - this.startedAtMs);
    if (remainingMs === 0) {
      return { phase: normalizedPhase, allowed: false, finishFirst: true, remainingMs, reserveMs, phaseBudgetMs, reason: "deadline_expired" };
    }
    if (remainingMs <= reserveMs && normalizedPhase !== "complete") {
      return { phase: normalizedPhase, allowed: false, finishFirst: true, remainingMs, reserveMs, phaseBudgetMs, reason: "finalization_reserve" };
    }
    if (phaseBudgetMs !== undefined && elapsedMs > phaseBudgetMs && normalizedPhase !== "complete") {
      return { phase: normalizedPhase, allowed: false, finishFirst: true, remainingMs, reserveMs, phaseBudgetMs, reason: "phase_budget_exhausted" };
    }
    return { phase: normalizedPhase, allowed: true, finishFirst: false, remainingMs, reserveMs, phaseBudgetMs, reason: "within_budget" };
  }
}

function normalizePhase(phase: string): PhaseBudgetPhase {
  if (phase === "sources" || phase === "matrices" || phase === "issues" || phase === "authorities" || phase === "coverage" || phase === "complete") {
    return phase;
  }
  return "incomplete";
}
