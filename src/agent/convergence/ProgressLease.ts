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
  nextBatch?: unknown;
  writeBudget?: unknown;
};

export type ProgressBoundaryOutcome = {
  requested: boolean;
  attempted: boolean;
  applied: boolean;
  rejectionReason?: string;
};

export type ProgressLeaseObservation = {
  scope: string;
  phase: string;
  blockingCode?: string;
  remainingCount: number;
  progressOrdinal?: number;
  repairOrdinal?: number;
  stagnantObservations: number;
  decision: "baseline" | "renewed" | "completed" | "stagnant" | "boundary_grace" | "feedback_grace" | "fail_closed";
  forceBoundaryNext: boolean;
  reason?: "boundary_unavailable" | "boundary_rejected" | "post_boundary_stagnation";
};

type ScopeState = {
  stateHash: string;
  remainingCount: number;
  progressOrdinal?: number;
  repairOrdinal?: number;
  stagnantObservations: number;
  awaitingPostBoundaryProgress: boolean;
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

  shouldForceBoundary(): boolean {
    if (!this.config?.enabled) return false;
    return [...this.scopes.values()].some((state) =>
      !state.awaitingPostBoundaryProgress
      && state.stagnantObservations >= this.stagnationLimit(state) - 1
    );
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
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
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
      this.scopes.set(report.scope, {
        stateHash: report.stateHash,
        remainingCount: report.remainingCount,
        progressOrdinal,
        repairOrdinal,
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
        hasProgressed: true,
      });
      return observation(report, 0, "renewed", false);
    }

    const stagnantObservations = existing.stagnantObservations + 1;
    const repairAdvanced = report.repairOrdinal !== undefined
      && (existing.repairOrdinal === undefined || report.repairOrdinal > existing.repairOrdinal);
    if (existing.awaitingPostBoundaryProgress) {
      if (repairAdvanced) {
        this.scopes.set(report.scope, {
          ...existing,
          repairOrdinal: report.repairOrdinal,
          stagnantObservations,
        });
        return observation(report, stagnantObservations, "feedback_grace", false);
      }
      return observation(report, stagnantObservations, "fail_closed", false, "post_boundary_stagnation");
    }

    if (boundary.applied) {
      this.scopes.set(report.scope, {
        ...existing,
        repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
        stagnantObservations,
        awaitingPostBoundaryProgress: true,
      });
      return observation(report, stagnantObservations, "boundary_grace", false);
    }

    if (boundary.requested) {
      const reason = boundary.attempted ? "boundary_rejected" : "boundary_unavailable";
      return observation(report, stagnantObservations, "fail_closed", false, reason);
    }

    this.scopes.set(report.scope, {
      ...existing,
      repairOrdinal: maxDefined(existing.repairOrdinal, report.repairOrdinal),
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
