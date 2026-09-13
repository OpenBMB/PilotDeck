/**
 * Delivery primitives for forked subagent runs.
 *
 * The host parses the child's final message as a delivery report, runs cheap
 * deterministic L1 checks (schema leaves + declared files), optionally hands a
 * bounded review packet to a reviewer model, and archives every attempt under
 * `.pilotdeck/deliveries/<subagentId>/attempt-<n>.json`.
 *
 * This module is pure types: no runtime, session, or UI coupling.
 */

import type { CanonicalUsage } from "../../../model/index.js";

/** Parent-supplied contract for a delivery. Absent fields mean "no constraint". */
export type DeliveryContract = {
  /** Incremental JSON-Schema-like shape; all properties optional, unknown fields allowed. */
  schema?: Record<string, unknown>;
  /** Whether a reviewer model pass is requested after auto checks. */
  review?: boolean;
};

/** One concrete, path-addressed problem found in a delivery. */
export type DeliveryIssue = {
  /** Dot path into the delivery report, e.g. `steps.0.output.file`. */
  path: string;
  /** Stable machine code, e.g. `type_mismatch`, `file_missing`, `outside_workspace`. */
  code: string;
  /** Human-readable explanation. */
  message: string;
};

/** Result of the deterministic (non-model) checks over one delivery attempt. */
export type DeliveryChecks = {
  status: "passed" | "failed" | "skipped" | "error";
  /** Number of meaningful checks performed; empty containers never increment. */
  checked: number;
  issues: DeliveryIssue[];
  /** Populated for `skipped` (no meaningful content) or `error` (internal/abort). */
  reason?: string;
};

/** Result of the optional reviewer-model pass over one delivery attempt. */
export type DeliveryReview = {
  status: "accepted" | "rejected" | "inconclusive" | "error" | "skipped";
  summary: string;
  issues: DeliveryIssue[];
  model?: { provider: string; model: string };
  usage?: CanonicalUsage;
  durationMs: number;
};

/** One attempt: where the delivery was archived plus its checks/review. */
export type DeliveryAttempt = {
  attempt: number;
  deliveryFile: string;
  checks: DeliveryChecks;
  review?: DeliveryReview;
};

/** Aggregated outcome across all attempts of one subagent delivery flow. */
export type DeliveryResult = {
  status: "passed" | "failed" | "skipped" | "inconclusive" | "error";
  deliveryFile: string;
  attempts: DeliveryAttempt[];
  /** Number of repair round-trips requested from the child (0 = accepted first try). */
  repairs: number;
  producerUsage: CanonicalUsage;
  reviewUsage: CanonicalUsage;
};

/** Host-side runtime configuration for the delivery loop. */
export type DeliveryRuntimeConfig = {
  mode: "auto" | "off";
  /** Overrides the default child-facing delivery guidance when non-empty. */
  prompt?: string;
  maxRepairs: number;
  maxTurns: number;
  reviewerModel?: { provider: string; model: string };
  reviewTimeoutMs: number;
  maxReviewInputTokens: number;
  maxReviewOutputTokens: number;
};
