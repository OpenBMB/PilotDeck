export const CONVERGENCE_METADATA_KEY = "pilotdeckConvergence";

export type ProgressLeaseConfig = {
  enabled: true;
  mode: "evaluation";
  maxStagnantObservations: number;
};

export type ConvergenceReport = {
  schemaVersion: 1;
  scope: string;
  phase: string;
  stateHash: string;
  blockingCode?: string;
  remainingCount: number;
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
  stagnantObservations: number;
  decision: "baseline" | "renewed" | "completed" | "stagnant" | "boundary_grace" | "fail_closed";
  forceBoundaryNext: boolean;
  reason?: "boundary_unavailable" | "boundary_rejected" | "post_boundary_stagnation";
};

type ScopeState = {
  stateHash: string;
  remainingCount: number;
  stagnantObservations: number;
  awaitingPostBoundaryProgress: boolean;
};

/**
 * Domain-neutral convergence guard. State hashes and counts are deliberately
 * opaque: Core decides only whether progress changed, never what it means.
 */
export class ProgressLease {
  private readonly scopes = new Map<string, ScopeState>();

  constructor(private readonly config?: ProgressLeaseConfig) {}

  shouldForceBoundary(): boolean {
    if (!this.config?.enabled) return false;
    return [...this.scopes.values()].some((state) =>
      !state.awaitingPostBoundaryProgress
      && state.stagnantObservations >= this.config!.maxStagnantObservations - 1
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
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
      });
      return observation(report, 0, "baseline", false);
    }

    const progressed = report.stateHash !== existing.stateHash
      || report.remainingCount < existing.remainingCount;
    if (progressed) {
      this.scopes.set(report.scope, {
        stateHash: report.stateHash,
        remainingCount: report.remainingCount,
        stagnantObservations: 0,
        awaitingPostBoundaryProgress: false,
      });
      return observation(report, 0, "renewed", false);
    }

    const stagnantObservations = existing.stagnantObservations + 1;
    if (existing.awaitingPostBoundaryProgress) {
      return observation(report, stagnantObservations, "fail_closed", false, "post_boundary_stagnation");
    }

    if (boundary.applied) {
      this.scopes.set(report.scope, {
        ...existing,
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
      stagnantObservations,
    });
    return observation(
      report,
      stagnantObservations,
      "stagnant",
      stagnantObservations >= this.config.maxStagnantObservations - 1,
    );
  }
}

export function parseConvergenceReport(value: unknown): ConvergenceReport | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (!boundedString(value.scope, 128) || !boundedString(value.phase, 128)) return undefined;
  if (!boundedString(value.stateHash, 256)) return undefined;
  if (!Number.isSafeInteger(value.remainingCount) || (value.remainingCount as number) < 0) return undefined;
  if (value.blockingCode !== undefined && !boundedString(value.blockingCode, 256)) return undefined;
  return {
    schemaVersion: 1,
    scope: value.scope,
    phase: value.phase,
    stateHash: value.stateHash,
    ...(value.blockingCode !== undefined ? { blockingCode: value.blockingCode } : {}),
    remainingCount: value.remainingCount,
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
