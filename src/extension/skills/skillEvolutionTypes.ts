import type { SkillAddressInput, SkillScope, SkillSummary } from "./types.js";

export type SkillEvolutionFeedbackOutcome = "success" | "failure" | "correction";

export type SkillEvolutionEventType =
  | "used"
  | "feedback"
  | "applied"
  | "rolled_back";

export type SkillEvolutionEvent = {
  id: string;
  type: SkillEvolutionEventType;
  at: string;
  scope: SkillScope;
  slug: string;
  outcome?: SkillEvolutionFeedbackOutcome;
  feedback?: string;
  sessionKey?: string;
  proposalId?: string;
  revisionId?: string;
};

export type SkillEvolutionStats = {
  useCount: number;
  successCount: number;
  failureCount: number;
  correctionCount: number;
  applyCount: number;
  rollbackCount: number;
  lastUsedAt: string | null;
  lastFeedbackAt: string | null;
  lastEvolvedAt: string | null;
};

export type SkillEvolutionProposalStatus =
  | "pending"
  | "applied"
  | "rolled_back"
  | "superseded";

export type SkillEvolutionProposalSummary = {
  id: string;
  scope: SkillScope;
  slug: string;
  projectKey: string | null;
  createdAt: string;
  summary: string;
  rationale: string;
  baseHash: string;
  candidateHash: string;
  status: SkillEvolutionProposalStatus;
  appliedAt?: string;
  revisionId?: string;
};

export type SkillEvolutionRevisionSummary = {
  id: string;
  scope: SkillScope;
  slug: string;
  createdAt: string;
  reason: "apply" | "rollback-safety";
  contentHash: string;
  sourceProposalId?: string;
};

export type SkillEvolutionSkillStatus = {
  skill: SkillSummary;
  stats: SkillEvolutionStats;
  recentEvents: SkillEvolutionEvent[];
  proposals: SkillEvolutionProposalSummary[];
  revisions: SkillEvolutionRevisionSummary[];
};

export type SkillEvolutionStatusInput = {
  projectKey?: string | null;
  scope?: SkillScope;
  slug?: string;
  /** Number of recent events, proposals, and revisions returned per skill. */
  limit?: number;
};

export type SkillEvolutionStatusResult = {
  skills: SkillEvolutionSkillStatus[];
  projectPath: string | null;
};

export type SkillEvolutionRecordInput = SkillAddressInput & {
  outcome: SkillEvolutionFeedbackOutcome;
  feedback?: string;
  sessionKey?: string;
};

export type SkillEvolutionRecordResult = {
  ok: true;
  event: SkillEvolutionEvent;
};

export type SkillEvolutionProposeInput = SkillAddressInput & {
  /** Optional feedback is recorded before the proposal is generated. */
  feedback?: string;
  outcome?: SkillEvolutionFeedbackOutcome;
  sessionKey?: string;
  /** Extra maintainer guidance for this one evolution pass. */
  instructions?: string;
};

export type SkillEvolutionProposeResult = {
  proposal: SkillEvolutionProposalSummary;
  /** Full candidate SKILL.md, returned so CLI/SDK callers can inspect the proposal. */
  candidateContent: string;
};

export type SkillEvolutionApplyInput = SkillAddressInput & {
  proposalId: string;
  /** Ignore a base-hash mismatch caused by an intervening manual edit. */
  force?: boolean;
};

export type SkillEvolutionApplyResult = {
  ok: true;
  proposal: SkillEvolutionProposalSummary;
  revision: SkillEvolutionRevisionSummary;
  skill: SkillSummary | null;
};

export type SkillEvolutionRollbackInput = SkillAddressInput & {
  /** Defaults to the newest revision for this skill. */
  revisionId?: string;
};

export type SkillEvolutionRollbackResult = {
  ok: true;
  rolledBackToRevisionId: string;
  safetyRevision: SkillEvolutionRevisionSummary;
  skill: SkillSummary | null;
};

export type SkillEvolutionGeneratorInput = {
  scope: SkillScope;
  slug: string;
  projectKey: string | null;
  currentContent: string;
  stats: SkillEvolutionStats;
  recentEvents: SkillEvolutionEvent[];
  instructions?: string;
};

export type SkillEvolutionDraft = {
  summary: string;
  rationale: string;
  content: string;
};

export type SkillEvolutionGenerator = (
  input: SkillEvolutionGeneratorInput,
) => Promise<SkillEvolutionDraft>;
