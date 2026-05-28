/**
 * Pure-function status computation for discovery plans.
 *
 * Extracted from `ui/server/discovery-plans.js` so that all clients
 * (Web UI, CLI, future SDK) can share the same status derivation.
 *
 * These functions operate on the "web plan record" shape — the
 * superset of fields that ui/server materializes for the React
 * frontend. They are intentionally decoupled from the gateway's
 * storage-shaped `DiscoveryPlanRecord`.
 */

export type WebPlanStatus =
  | "running"
  | "queued"
  | "ready"
  | "failed"
  | "completed"
  | "archived";

export type WebPlanRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  summary: string;
  rationale: string;
  dedupeKey: string;
  sourceDiscoverySessionId: string;
  executionSessionId: string;
  executionStartedAt: string;
  executionLastActivityAt: string;
  executionStatus: string;
  latestSummary: string;
  contextRefs: WebPlanContextRefs;
  planFilePath: string;
  reportFilePath?: string;
  structureVersion: number;
  lastExecutionSource?: string;
  workCycleId?: string;
  /** @deprecated Retained for migration only. */
  workspace?: {
    strategy: string;
    cwd: string;
  };
};

export type WebCycleRecord = {
  id: string;
  projectKey: string;
  status: string;
  workspace: {
    strategy: string;
    cwd: string;
  };
  planIds: string[];
  createdAt: string;
  appliedAt?: string;
  archivedAt?: string;
};

export type WebPlanContextRefs = {
  workingDirectory: string[];
  memory: string[];
  existingPlans: string[];
  cronJobs: string[];
  recentChats: string[];
};

export type WebPlanSession = {
  id?: string;
  createdAt?: string;
  created_at?: string;
  lastActivity?: string;
  updated_at?: string;
  lastAssistantMessage?: string;
  summary?: string;
  title?: string;
} | null;

export const PLAN_STATUS_ORDER: Record<string, number> = {
  running: 0,
  queued: 2,
  ready: 3,
  failed: 4,
  completed: 5,
  archived: 7,
};

export function computeExecutionStatus(
  plan: WebPlanRecord,
  session: WebPlanSession,
  isSessionActive: (sessionId: string) => boolean,
): string {
  if (plan.status === "archived") return "";

  if (plan.executionSessionId && isSessionActive(plan.executionSessionId)) {
    return "running";
  }

  if (plan.executionStatus === "failed") return "failed";
  if (plan.executionStatus === "completed") return "completed";

  if (plan.executionStatus === "queued") {
    return plan.executionSessionId && session ? "completed" : "queued";
  }

  if (plan.executionStatus === "running") {
    return plan.executionSessionId && session ? "completed" : "running";
  }

  if (plan.executionSessionId && session) return "completed";

  if (
    plan.status === "queued" ||
    plan.status === "running" ||
    plan.status === "completed" ||
    plan.status === "failed"
  ) {
    return plan.status;
  }

  return "";
}

export function computePlanStatus(
  plan: WebPlanRecord,
  session: WebPlanSession,
  isSessionActive: (sessionId: string) => boolean,
): string {
  if (plan.status === "archived") return "archived";
  const execStatus = computeExecutionStatus(plan, session, isSessionActive);
  if (execStatus) return execStatus;
  return normalizeString(plan.status, "ready");
}

export function sortDiscoveryPlans<T extends { status: string; updatedAt?: string }>(plans: T[]): T[] {
  return [...plans].sort((left, right) => {
    const leftOrder = PLAN_STATUS_ORDER[left.status] ?? 99;
    const rightOrder = PLAN_STATUS_ORDER[right.status] ?? 99;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (toTimestampValue(right.updatedAt) ?? 0) - (toTimestampValue(left.updatedAt) ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Shared utility helpers (also used by DiscoveryPlanService)
// ---------------------------------------------------------------------------

export function toTimestampValue(value: string | undefined | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function toIsoTimestamp(value: string | undefined | null): string {
  const timestamp = toTimestampValue(value);
  return timestamp === null ? "" : new Date(timestamp).toISOString();
}

export function pickLatestIsoTimestamp(...values: (string | undefined | null)[]): string {
  let latest: number | null = null;
  for (const value of values) {
    const timestamp = toTimestampValue(value);
    if (timestamp === null) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest === null ? "" : new Date(latest).toISOString();
}

export function normalizeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function truncateText(value: unknown, maxLength = 220): string {
  const normalized = normalizeString(value).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}
