/**
 * Public protocol types for Skill / Harness Evo.
 *
 * Evo continuously looks at what actually happened in a project (ProjectWiki,
 * source cards, transcripts, tool results, user-confirmed output), discovers
 * where a skill or a piece of the harness is not serving the project well, and
 * proposes — or, depending on the project policy, directly applies — an
 * improvement.
 *
 * These types are shared between the gateway, its remote clients (the UI server
 * bridge) and any future SDK consumer. Like the skill protocol, callers never
 * see absolute paths: a target is addressed by `(kind, scope, slug)` for skills
 * or `(kind, configKey)` for harness config, and the manager owns the on-disk
 * layout under `~/.pilotdeck/evo/`.
 */

import type { SkillScope } from "../../extension/skills/types.js";

/**
 * Per-project policy controlling how aggressively Evo applies candidates.
 *
 * - `manual`        — every change is shown to the user; nothing is applied
 *                     until the user approves.
 * - `auto-low-risk` — low-risk changes are applied automatically; medium and
 *                     high risk still need approval.
 * - `auto-all`      — apply as much as possible automatically; high-risk
 *                     changes still require approval (harness core / scripts).
 */
export type EvoPolicyMode = "manual" | "auto-low-risk" | "auto-all";

export const EVO_POLICY_MODES: EvoPolicyMode[] = ["manual", "auto-low-risk", "auto-all"];

export const DEFAULT_EVO_POLICY: EvoPolicyMode = "manual";

/**
 * Risk grading for a candidate change.
 *
 * - `low`    — skill description, project paths, test commands.
 * - `medium` — skill body / flow, router / tool policy.
 * - `high`   — harness core config, executable scripts, cross-project impact.
 */
export type EvoRiskLevel = "low" | "medium" | "high";

/** What kind of object the candidate targets. ProjectWiki is never a target. */
export type EvoTargetKind = "skill" | "harness";

/**
 * Harness config categories Evo is allowed to touch. These map to a config
 * file under `<project>/.pilotdeck/evo/harness/<configKey>.json`. The harness
 * core code / executable scripts are deliberately NOT addressable here — they
 * are always high-risk and live outside this surface.
 */
export type EvoHarnessConfigKey =
  | "router"
  | "tool-policy"
  | "context"
  | "always-on"
  | "prompt-fragment";

export const EVO_HARNESS_CONFIG_KEYS: EvoHarnessConfigKey[] = [
  "router",
  "tool-policy",
  "context",
  "always-on",
  "prompt-fragment",
];

export type EvoSkillTarget = {
  kind: "skill";
  scope: SkillScope;
  slug: string;
  projectKey?: string | null;
};

export type EvoHarnessTarget = {
  kind: "harness";
  configKey: EvoHarnessConfigKey;
  projectKey?: string | null;
};

export type EvoTarget = EvoSkillTarget | EvoHarnessTarget;

/**
 * A piece of evidence the candidate is grounded in — a summary plus its
 * provenance. Mirrors the plan's `source_cards`: a conversation, a repo file,
 * a feedback item, a failed tool call, etc.
 */
export type EvoSourceCard = {
  id: string;
  /** e.g. "project-wiki" | "transcript" | "tool-result" | "feedback" | "skill" */
  kind: string;
  title: string;
  detail?: string;
  /** Where it came from (path, session id, url …) for the user to verify. */
  ref?: string;
};

/**
 * Project facts Evo uses to adapt a freshly installed skill (or improve an
 * existing one) to the current project. All optional — whatever the caller can
 * supply from ProjectWiki / project metadata.
 */
export type EvoProjectFacts = {
  projectName?: string;
  description?: string;
  /** e.g. "npm run test" */
  testCommand?: string;
  /** Common paths in the project. */
  commonPaths?: string[];
  /** Code-style notes. */
  codeStyle?: string;
  /** Free-form extra notes. */
  notes?: string;
};

/** One generated candidate version — never overwrites the original in place. */
export type EvoCandidate = {
  /** Snapshot of the target content before any change. */
  baseContent: string;
  /** Proposed new content. */
  candidateContent: string;
  /** Improvement hypothesis: because of X, changing Y should help. */
  hypothesis: string;
  riskLevel: EvoRiskLevel;
  /** Specific risk points the reviewer should look at. */
  riskNotes: string[];
};

/** A single manual eval item replayed against base + candidate. */
export type EvoEvalItem = {
  id: string;
  /** The task / prompt that historically used this skill. */
  input: string;
  /** Optional keywords/phrases the produced content is expected to cover. */
  expected?: string[];
};

export type EvoEvalScore = {
  itemId: string;
  baselineScore: number;
  candidateScore: number;
  note?: string;
};

/**
 * Aggregate comparison of base vs candidate over the eval set. Approximates the
 * plan's "综合分析报告" — error rate, rounds, output quality — at the MVP level.
 */
export type EvoEvalReport = {
  itemCount: number;
  baselineScore: number;
  candidateScore: number;
  /** candidateScore - baselineScore. */
  delta: number;
  improved: boolean;
  baselineErrorRate: number;
  candidateErrorRate: number;
  scores: EvoEvalScore[];
};

export type EvoRecommendation = "apply" | "review" | "reject";

export type EvoReport = {
  runId: string;
  target: EvoTarget;
  hypothesis: string;
  sourceCards: EvoSourceCard[];
  riskLevel: EvoRiskLevel;
  riskNotes: string[];
  eval: EvoEvalReport | null;
  recommendation: EvoRecommendation;
  createdAt: string;
};

export type EvoRunStatus =
  | "proposed"
  | "ready"
  | "applied"
  | "discarded"
  | "failed";

/** What is needed to undo an applied change. */
export type EvoRollbackInfo = {
  /** Content before the change, for a one-click revert. */
  previousContent: string;
  /** True when the target did not exist before (apply created it). */
  createdByApply: boolean;
};

export type EvoRun = {
  runId: string;
  projectKey: string | null;
  target: EvoTarget;
  status: EvoRunStatus;
  policy: EvoPolicyMode;
  /** Why this change is being proposed (human-readable). */
  reason: string;
  candidate: EvoCandidate;
  report: EvoReport;
  rollback: EvoRollbackInfo | null;
  autoApplied: boolean;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  discardedAt?: string;
};

/** Lightweight row for run lists. */
export type EvoRunSummary = {
  runId: string;
  projectKey: string | null;
  target: EvoTarget;
  status: EvoRunStatus;
  riskLevel: EvoRiskLevel;
  recommendation: EvoRecommendation;
  hypothesis: string;
  autoApplied: boolean;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Gateway RPC input / output
// ---------------------------------------------------------------------------

export type EvoStartInput = {
  projectKey?: string | null;
  target: EvoTarget;
  /**
   * Optional policy override. When provided it is persisted as the project's
   * Evo policy and used for this run.
   */
  policy?: EvoPolicyMode;
  /** Human-readable reason the run was triggered. */
  reason?: string;
  /** Evidence the candidate is grounded in. */
  sourceCards?: EvoSourceCard[];
  /** Project facts used to adapt the target. */
  projectFacts?: EvoProjectFacts;
  /** Improvement hypothesis (proposers may refine it). */
  hypothesis?: string;
  /**
   * Explicit candidate content. When provided the default proposer uses it
   * verbatim instead of generating one heuristically — used by callers that
   * already have a complete proposed document.
   */
  candidateContent?: string;
  /** Manual eval set replayed against base + candidate. */
  evalSet?: EvoEvalItem[];
};

export type EvoStartResult = {
  run: EvoRun | null;
  error?: { code: string; message: string };
};

export type EvoStatusInput = {
  /** When set, return that single run. */
  runId?: string;
  /** When set (and no runId), list runs for the project. */
  projectKey?: string | null;
};

export type EvoStatusResult = {
  run: EvoRun | null;
  runs: EvoRunSummary[];
  policy: EvoPolicyMode;
  error?: { code: string; message: string };
};

export type EvoReportInput = { runId: string };

export type EvoReportResult = {
  report: EvoReport | null;
  /** Rendered markdown for direct display in the UI. */
  markdown: string;
  error?: { code: string; message: string };
};

export type EvoApplyInput = { runId: string };

export type EvoApplyResult = {
  run: EvoRun | null;
  error?: { code: string; message: string };
};

export type EvoDiscardInput = { runId: string };

export type EvoDiscardResult = {
  run: EvoRun | null;
  error?: { code: string; message: string };
};
