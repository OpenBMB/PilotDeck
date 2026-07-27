export const CONVERGENCE_METADATA_KEY = "pilotdeckConvergence";

export type ProgressLeaseConfig = {
  enabled: true;
  mode: "evaluation";
  maxStagnantObservations: number;
  maxInitialStagnantObservations?: number;
};

export type ConvergenceReport = {
  schemaVersion: 1;
  scope: string;
  phase: string;
  stateHash: string;
  blockingCode?: string;
  remainingCount: number;
  /** Domain-issued monotonic witness. Core only compares the ordinal. */
  progressOrdinal?: number;
  /** Domain-issued stable repair-feedback revision. Never counts as progress. */
  repairOrdinal?: number;
  /** Domain-issued proof that the current repair target was prepared. Never counts as progress. */
  repairPreparationOrdinal?: number;
  /** Domain-issued stable operational handoff. Never counts as progress. */
  handoffOrdinal?: number;
  nextBatch?: unknown;
  writeBudget?: unknown;
};

export type ProgressBoundaryOutcome = {
  requested: boolean;
  attempted: boolean;
  applied: boolean;
  rejectionReason?: string;
};

export type ProgressBoundaryPlan = {
  requested: boolean;
  deferredScopes: string[];
};

export type ProgressLeaseObservation = {
  scope: string;
  phase: string;
  blockingCode?: string;
  remainingCount: number;
  progressOrdinal?: number;
  repairOrdinal?: number;
  repairPreparationOrdinal?: number;
  handoffOrdinal?: number;
  stagnantObservations: number;
  decision: "baseline" | "renewed" | "completed" | "stagnant" | "boundary_grace" | "feedback_grace" | "repair_preparation_grace" | "handoff_grace" | "fail_closed";
  forceBoundaryNext: boolean;
  reason?: "boundary_unavailable" | "boundary_rejected" | "post_boundary_stagnation";
};

type ScopeState = {
  stateHash: string;
  remainingCount: number;
  progressOrdinal?: number;
  repairOrdinal?: number;
  repairPreparationOrdinal?: number;
  handoffOrdinal?: number;
  handoffsUsedSinceProgress: number;
  stagnantObservations: number;
  awaitingPostBoundaryProgress: boolean;
  feedbackGraceUsed: boolean;
  repairPreparationGraceUsed: boolean;
  hasProgressed: boolean;
};

/**
 * Domain-neutral convergence guard. State hashes remain opaque identity only;
 * lease renewal requires a smaller remaining count or a domain-issued
 * monotonic progress ordinal.
 */
export class ProgressLease {
  private readonly scopes = new Map<string, ScopeState>();

  constructor(private readonly config?: ProgressLeaseConfig) {}

  shouldForceBoundary(previews: readonly ConvergenceReport[] = []): boolean {
    return this.planBoundary(previews).requested;
  }

  planBoundary(previews: readonly ConvergenceReport[] = []): ProgressBoundaryPlan {
    if (!this.config?.enabled) return { requested: false, deferredScopes: [] };
    const required = [...this.scopes.entries()].filter(([, state]) =>
      !state.awaitingPostBoundaryProgress
      && state.stagnantObservations >= this.stagnationLimit(state) - 1
    );
    if (required.length === 0) return { requested: false, deferredScopes: [] };
    if (required.length !== 1) return { requested: true, deferredScopes: [] };

    const previewByScope = new Map<string, ConvergenceReport>();
    for (const preview of previews) previewByScope.set(preview.scope, preview);
    const deferredScopes = required.flatMap(([scope, state]) => {
      const preview = previewByScope.get(scope);
      return preview && this.previewCanDeferBoundary(state, preview) ? [scope] : [];
    });
    if (deferredScopes.length !== required.length) {
      return { requested: true, deferredScopes: [] };
    }
    return { requested: false, deferredScopes: deferredScopes.sort() };
  }

  observe(
    report: ConvergenceReport,
    boundary: ProgressBoundaryOutcome,
  ): ProgressLeaseObservation | undefined {
    if (!this.config?.enabled) return undefined;

    const existing = this.scopes.get(report.scope);
    if (report.remainingCount === 0 && report.blockingCode === undefined) {
      this.scopes.delete(report.scope);
      return observation(report, 0, "completed", false);
    }

    if (!existing) {
      this.scopes.set(report.scope, {
        stateHash: report.stateHash,
        remainingCount: report.remainingCount,
        progressOrdinal: report.progressOrdinal,
        repairOrdinal: report.repairOrdinal,
        repairPreparationOrdinal: report.repairPreparationOrdinal,
        handoffOrdinal: report.handoffOrdinal,
        handoffsUsedSinceProgress: 0,
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
        feedbackGraceUsed: false,
        repairPreparationGraceUsed: false,
        hasProgressed: false,
      });
      return observation(report, 0, "baseline", false);
    }

    const progressed = report.remainingCount < existing.remainingCount
      || (report.progressOrdinal !== undefined
        && (existing.progressOrdinal === undefined || report.progressOrdinal > existing.progressOrdinal));
    if (progressed) {
      const progressOrdinal = maxDefined(existing.progressOrdinal, report.progressOrdinal);
      const repairOrdinal = maxDefined(existing.repairOrdinal, report.repairOrdinal);
      const repairPreparationOrdinal = maxDefined(
        existing.repairPreparationOrdinal,
        report.repairPreparationOrdinal,
      );
      const handoffOrdinal = maxDefined(existing.handoffOrdinal, report.handoffOrdinal);
      this.scopes.set(report.scope, {
        stateHash: report.stateHash,
        remainingCount: report.remainingCount,
        progressOrdinal,
        repairOrdinal,
        repairPreparationOrdinal,
        handoffOrdinal,
        handoffsUsedSinceProgress: 0,
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
        feedbackGraceUsed: false,
        repairPreparationGraceUsed: false,
        hasProgressed: true,
      });
      return observation(report, 0, "renewed", false);
    }

    const stagnantObservations = existing.stagnantObservations + 1;
    const repairAdvanced = report.repairOrdinal !== undefined
      && (existing.repairOrdinal === undefined || report.repairOrdinal > existing.repairOrdinal);
    const repairPreparationAdvanced = report.repairPreparationOrdinal !== undefined
      && (existing.repairPreparationOrdinal === undefined
        || report.repairPreparationOrdinal > existing.repairPreparationOrdinal);
    const handoffAdvanced = report.handoffOrdinal !== undefined
      && (existing.handoffOrdinal === undefined || report.handoffOrdinal > existing.handoffOrdinal);
    const handoffsUsedSinceProgress = handoffAdvanced
      ? Math.min(Number.MAX_SAFE_INTEGER, existing.handoffsUsedSinceProgress + 1)
      : existing.handoffsUsedSinceProgress;
    const handoffWithinBudget = handoffAdvanced
      && existing.handoffsUsedSinceProgress < this.handoffLimit();
    if (existing.awaitingPostBoundaryProgress) {
      if (handoffWithinBudget) {
        this.scopes.set(report.scope, {
          ...existing,
          repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
          repairPreparationOrdinal: maxDefined(
            existing.repairPreparationOrdinal,
            report.repairPreparationOrdinal,
          ),
          handoffOrdinal: report.handoffOrdinal,
          handoffsUsedSinceProgress,
          stagnantObservations,
        });
        return observation(report, stagnantObservations, "handoff_grace", false);
      }
      if (repairAdvanced && !existing.feedbackGraceUsed) {
        this.scopes.set(report.scope, {
          ...existing,
          repairOrdinal: report.repairOrdinal,
          repairPreparationOrdinal: maxDefined(
            existing.repairPreparationOrdinal,
            report.repairPreparationOrdinal,
          ),
          handoffOrdinal: maxDefined(existing.handoffOrdinal, report.handoffOrdinal),
          handoffsUsedSinceProgress,
          stagnantObservations,
          feedbackGraceUsed: true,
        });
        return observation(report, stagnantObservations, "feedback_grace", false);
      }
      if (existing.feedbackGraceUsed
        && !existing.repairPreparationGraceUsed
        && repairPreparationAdvanced
      ) {
        this.scopes.set(report.scope, {
          ...existing,
          repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
          repairPreparationOrdinal: report.repairPreparationOrdinal,
          handoffOrdinal: maxDefined(existing.handoffOrdinal, report.handoffOrdinal),
          handoffsUsedSinceProgress,
          stagnantObservations,
          repairPreparationGraceUsed: true,
        });
        return observation(report, stagnantObservations, "repair_preparation_grace", false);
      }
      return observation(report, stagnantObservations, "fail_closed", false, "post_boundary_stagnation");
    }

    if (boundary.applied) {
      this.scopes.set(report.scope, {
        ...existing,
        repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
        repairPreparationOrdinal: maxDefined(
          existing.repairPreparationOrdinal,
          report.repairPreparationOrdinal,
        ),
        handoffOrdinal: maxDefined(existing.handoffOrdinal, report.handoffOrdinal),
        handoffsUsedSinceProgress,
        stagnantObservations,
        awaitingPostBoundaryProgress: true,
        feedbackGraceUsed: repairAdvanced,
        repairPreparationGraceUsed: repairPreparationAdvanced,
      });
      return observation(report, stagnantObservations, "boundary_grace", false);
    }

    if (boundary.requested) {
      const reason = boundary.attempted ? "boundary_rejected" : "boundary_unavailable";
      return observation(report, stagnantObservations, "fail_closed", false, reason);
    }

    if (handoffWithinBudget) {
      this.scopes.set(report.scope, {
        ...existing,
        repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
        repairPreparationOrdinal: maxDefined(
          existing.repairPreparationOrdinal,
          report.repairPreparationOrdinal,
        ),
        handoffOrdinal: report.handoffOrdinal,
        handoffsUsedSinceProgress,
        stagnantObservations,
      });
      return observation(
        report,
        stagnantObservations,
        "handoff_grace",
        stagnantObservations >= this.stagnationLimit(existing) - 1,
      );
    }

    this.scopes.set(report.scope, {
      ...existing,
      repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
      repairPreparationOrdinal: maxDefined(
        existing.repairPreparationOrdinal,
        report.repairPreparationOrdinal,
      ),
      handoffOrdinal: maxDefined(existing.handoffOrdinal, report.handoffOrdinal),
      handoffsUsedSinceProgress,
      stagnantObservations,
    });
    return observation(
      report,
      stagnantObservations,
      "stagnant",
      stagnantObservations >= this.stagnationLimit(existing) - 1,
    );
  }

  private stagnationLimit(state: ScopeState): number {
    if (state.hasProgressed) return this.config!.maxStagnantObservations;
    return this.config!.maxInitialStagnantObservations ?? this.config!.maxStagnantObservations;
  }

  private handoffLimit(): number {
    return this.config!.maxInitialStagnantObservations ?? this.config!.maxStagnantObservations;
  }

  private previewCanDeferBoundary(state: ScopeState, preview: ConvergenceReport): boolean {
    if (preview.remainingCount === 0 && preview.blockingCode === undefined) return true;
    const progressed = preview.remainingCount < state.remainingCount
      || (preview.progressOrdinal !== undefined
        && (state.progressOrdinal === undefined || preview.progressOrdinal > state.progressOrdinal));
    if (progressed) return true;
    const handoffAdvanced = preview.handoffOrdinal !== undefined
      && (state.handoffOrdinal === undefined || preview.handoffOrdinal > state.handoffOrdinal);
    return handoffAdvanced && state.handoffsUsedSinceProgress < this.handoffLimit();
  }
}

export function parseConvergenceReport(value: unknown): ConvergenceReport | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (!boundedString(value.scope, 128) || !boundedString(value.phase, 128)) return undefined;
  if (!boundedString(value.stateHash, 256)) return undefined;
  if (!Number.isSafeInteger(value.remainingCount) || (value.remainingCount as number) < 0) return undefined;
  if (value.progressOrdinal !== undefined
    && (!Number.isSafeInteger(value.progressOrdinal) || (value.progressOrdinal as number) < 0)
  ) return undefined;
  if (value.repairOrdinal !== undefined
    && (!Number.isSafeInteger(value.repairOrdinal) || (value.repairOrdinal as number) < 0)
  ) return undefined;
  if (value.repairPreparationOrdinal !== undefined
    && (!Number.isSafeInteger(value.repairPreparationOrdinal)
      || (value.repairPreparationOrdinal as number) < 0)
  ) return undefined;
  if (value.handoffOrdinal !== undefined
    && (!Number.isSafeInteger(value.handoffOrdinal) || (value.handoffOrdinal as number) < 0)
  ) return undefined;
  if (value.blockingCode !== undefined && !boundedString(value.blockingCode, 256)) return undefined;
  return {
    schemaVersion: 1,
    scope: value.scope,
    phase: value.phase,
    stateHash: value.stateHash,
    ...(value.blockingCode !== undefined ? { blockingCode: value.blockingCode } : {}),
    remainingCount: value.remainingCount,
    ...(value.progressOrdinal !== undefined ? { progressOrdinal: value.progressOrdinal } : {}),
    ...(value.repairOrdinal !== undefined ? { repairOrdinal: value.repairOrdinal } : {}),
    ...(value.repairPreparationOrdinal !== undefined
      ? { repairPreparationOrdinal: value.repairPreparationOrdinal }
      : {}),
    ...(value.handoffOrdinal !== undefined ? { handoffOrdinal: value.handoffOrdinal } : {}),
    ...(value.nextBatch !== undefined ? { nextBatch: value.nextBatch } : {}),
    ...(value.writeBudget !== undefined ? { writeBudget: value.writeBudget } : {}),
  } as ConvergenceReport;
}

function observation(
  report: ConvergenceReport,
  stagnantObservations: number,
  decision: ProgressLeaseObservation["decision"],
  forceBoundaryNext: boolean,
  reason?: ProgressLeaseObservation["reason"],
): ProgressLeaseObservation {
  return {
    scope: report.scope,
    phase: report.phase,
    blockingCode: report.blockingCode,
    remainingCount: report.remainingCount,
    ...(report.progressOrdinal !== undefined ? { progressOrdinal: report.progressOrdinal } : {}),
    ...(report.repairOrdinal !== undefined ? { repairOrdinal: report.repairOrdinal } : {}),
    ...(report.repairPreparationOrdinal !== undefined
      ? { repairPreparationOrdinal: report.repairPreparationOrdinal }
      : {}),
    ...(report.handoffOrdinal !== undefined ? { handoffOrdinal: report.handoffOrdinal } : {}),
    stagnantObservations,
    decision,
    forceBoundaryNext,
    ...(reason ? { reason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
