import type {
  MemoryCandidate,
  MemoryManifestEntry,
  MemoryMessage,
  MemoryRoute,
  MemoryUserSummary,
  ProjectIdentityHint,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
  RecallHeaderEntry,
  RetrievalPromptDebug,
} from "../types.js";

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type ProviderHeaders = Record<string, string> | undefined;
type PromptDebugSink = (debug: RetrievalPromptDebug) => void;

const REQUEST_RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_BASE_DELAY_MS = 1_000;

export interface FileMemoryExtractionDiscardedCandidate {
  reason: string;
  candidateType?: "user" | "feedback" | "project";
  candidateName?: string;
  summary?: string;
}

export interface FileMemoryExtractionDebug {
  parsedItems: unknown[];
  normalizedCandidates: MemoryCandidate[];
  discarded: FileMemoryExtractionDiscardedCandidate[];
  finalCandidates: MemoryCandidate[];
  fallbackApplied?: string;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatusCode(error: unknown): number | null {
  if (
    error
    && typeof error === "object"
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function isTransientRequestError(error: unknown): boolean {
  const status = getErrorStatusCode(error);
  if (status !== null) return REQUEST_RETRYABLE_STATUS_CODES.has(status);
  if (isTimeoutError(error)) return true;
  if (!(error instanceof Error)) return false;
  return /(fetch failed|network|econnreset|econnrefused|etimedout|socket hang up|temporar|rate limit|too many requests)/i
    .test(error.message);
}

function computeRetryDelayMs(attemptIndex: number): number {
  return DEFAULT_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attemptIndex);
}

function resolveRequestTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return 30_000;
  if (timeoutMs <= 0) return null;
  return timeoutMs;
}

interface ModelSelection {
  provider: string;
  model: string;
  api: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
}

interface RawUserProfilePayload {
  identity_background_markdown?: unknown;
  identity_background?: unknown;
}

type MemoryCreateKind = "user" | "project" | "feedback";

export interface MemoryClassificationLabel {
  type: MemoryCreateKind;
  reason: string;
  evidence: string;
}

export interface FileMemoryClassificationResult {
  shouldStore: boolean;
  labels: MemoryClassificationLabel[];
}

interface RawMemoryClassificationLabelPayload {
  type?: unknown;
  reason?: unknown;
  evidence?: unknown;
}

interface RawMemoryClassificationPayload {
  should_store?: unknown;
  labels?: unknown;
}

interface RawMemoryCreatePayload {
  skip?: unknown;
  reason?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface RawDreamFileGlobalPlanProjectPayload {
  plan_key?: unknown;
  target_project_id?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
  merge_reason?: unknown;
  evidence_entry_ids?: unknown;
  retained_entry_ids?: unknown;
}

interface RawDreamFileGlobalPlanPayload {
  summary?: unknown;
  duplicate_topic_count?: unknown;
  conflict_topic_count?: unknown;
  projects?: unknown;
  deleted_project_ids?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamFileProjectRewriteFilePayload {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  source_entry_ids?: unknown;
  stage?: unknown;
  decisions?: unknown;
  constraints?: unknown;
  next_steps?: unknown;
  blockers?: unknown;
  timeline?: unknown;
  notes?: unknown;
  rule?: unknown;
  why?: unknown;
  how_to_apply?: unknown;
}

interface RawDreamFileProjectRewritePayload {
  summary?: unknown;
  project_meta?: unknown;
  files?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamClusterPayload {
  member_relative_paths?: unknown;
  reason?: unknown;
}

interface RawDreamClusterPlanPayload {
  summary?: unknown;
  clusters?: unknown;
}

interface RawDreamClusterRefinePayload {
  summary?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface RawProjectMetaReviewPayload {
  should_update?: unknown;
  reason?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
}

interface RawGeneralProjectMetaMergeGroupPayload {
  keeper_project_id?: unknown;
  duplicate_project_ids?: unknown;
  reason?: unknown;
}

interface RawGeneralProjectMetaMergePlanPayload {
  summary?: unknown;
  merge_groups?: unknown;
}

const DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS = 600_000;
const DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS = 300_000;
const DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS = 120_000;
const DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS = 75_000;

const MEMORY_CLASSIFICATION_SYSTEM_PROMPT = `
You classify one focus user turn for a long-term memory indexing pipeline.

You are only deciding categories. Do not generate the memory file yet.

Rules:
- Base the decision on the focus user turn first.
- You may use the neighboring user/assistant turns only to disambiguate the focus turn.
- Assistant text is context only. Never classify something that exists only in assistant wording.
- A turn can match multiple categories, but at most once per category.
- Allowed categories:
  - user: cross-project durable personal identity/background facts about who the user is, such as name, profession, long-term role context, life background, or durable relationship context.
  - project: durable current-project facts such as what the project is, goals, scope, important progress, blockers, risks, key decisions.
  - feedback: current-project collaboration rules, delivery rules, output structure, title/body template rules, confirmed style guidance, language rules, and file/tool boundaries.
- Identity test: only use user when the focus turn is describing the user as a person.
- Override test: if another project could reasonably override this rule or preference, it is not user; classify it as feedback.
- Output test: if the turn is constraining how the assistant should reply, write, format, deliver, or touch files/tools, classify it as feedback.
- Project memory should prefer stable facts. Do not classify short-lived time-flow updates, percentages, or fleeting scheduling notes as project memory unless they carry a durable blocker/risk/fact.
- If the user explicitly says "请记住", "帮我记住", or "remember this", treat that as a stronger signal for durable memory. This is still inferred from the visible user text only.
- If nothing durable should be remembered, return should_store=false and labels=[].
- Return JSON only.

Use this exact JSON shape:
{
  "should_store": true,
  "labels": [
    {
      "type": "user | project | feedback",
      "reason": "why this category applies",
      "evidence": "short quote or evidence summary from the focus turn"
    }
  ]
}
`.trim();

const USER_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only user memory note from a focus user turn.

Rules:
- Create at most one user note.
- The note must capture only durable cross-project personal identity/background information about who the user is.
- Keep only long-lived identity facts such as name, profession, stable role context, life background, or durable relationship context.
- Do not include language choices, answer structure, formatting habits, style preferences, file boundaries, tool boundaries, or project-specific collaboration rules.
- One note should express one durable identity/background fact rather than a full profile rewrite.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Do not force the note into a fixed profile template. Use headings only when they genuinely help readability.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short user-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

const PROJECT_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only project memory note from a focus user turn.

Rules:
- Create at most one project note.
- The note belongs to the current project only.
- Capture durable project facts: what the project is, stable scope, goals, key progress, blockers, risks, important decisions, important next steps.
- Do not reduce the note to a vague status line.
- Do not focus on highly volatile percentages, fleeting schedules, or trivial short-term updates unless they reveal a durable blocker/risk/fact.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Prefer meaningful headings when useful, such as: ## Summary, ## Current Stage, ## Constraints, ## Blockers, ## Next Steps, ## Timeline, ## Notes.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short project-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

const FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only feedback memory note from a focus user turn.

Rules:
- Create at most one feedback note.
- The note belongs to the current project only.
- Use feedback for collaboration rules, delivery order, style constraints, title/body template rules, confirmed output expectations, language rules, and file/tool boundaries.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Prefer meaningful headings when useful, especially: ## Rule, ## Why, ## How To Apply, ## Notes.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short feedback-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

export interface LlmDreamFileProjectMetaInput {
  projectId: string;
  projectName: string;
  description: string;
  status: string;
  updatedAt: string;
  dreamUpdatedAt?: string;
  sourceKind?: string;
  sourceWorkspacePath?: string;
  sourceProjectId?: string;
}

export interface LlmDreamFileRecordInput {
  entryId: string;
  relativePath: string;
  type: "project" | "feedback";
  scope: "project";
  projectId?: string;
  isTmp: boolean;
  name: string;
  description: string;
  updatedAt: string;
  capturedAt?: string;
  sourceSessionKey?: string;
  content: string;
  project?: {
    stage: string;
    decisions: string[];
    constraints: string[];
    nextSteps: string[];
    blockers: string[];
    timeline: string[];
    notes: string[];
  };
  feedback?: {
    rule: string;
    why: string;
    howToApply: string;
    notes: string[];
  };
}

export interface LlmDreamFileGlobalPlanInput {
  currentProjects: LlmDreamFileProjectMetaInput[];
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileGlobalPlanProject {
  planKey: string;
  targetProjectId?: string;
  projectName: string;
  description: string;
  status: string;
  mergeReason?: "rename" | "alias_equivalence" | "duplicate_formal_project";
  evidenceEntryIds: string[];
  retainedEntryIds: string[];
}

export interface LlmDreamFileGlobalPlanOutput {
  summary: string;
  duplicateTopicCount: number;
  conflictTopicCount: number;
  projects: LlmDreamFileGlobalPlanProject[];
  deletedProjectIds: string[];
  deletedEntryIds: string[];
}

export interface LlmDreamFileProjectRewriteInput {
  project: LlmDreamFileGlobalPlanProject & { projectId: string };
  currentMeta: LlmDreamFileProjectMetaInput | null;
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileProjectRewriteOutputFile {
  type: "project" | "feedback";
  name: string;
  description: string;
  sourceEntryIds: string[];
  stage?: string;
  decisions?: string[];
  constraints?: string[];
  nextSteps?: string[];
  blockers?: string[];
  timeline?: string[];
  notes?: string[];
  rule?: string;
  why?: string;
  howToApply?: string;
}

export interface LlmDreamFileProjectRewriteOutput {
  summary: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
  files: LlmDreamFileProjectRewriteOutputFile[];
  deletedEntryIds: string[];
}

export interface LlmGeneralProjectMetaMergeInput {
  projectMetas: LlmDreamFileProjectMetaInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmGeneralProjectMetaMergeGroup {
  keeperProjectId: string;
  duplicateProjectIds: string[];
  reason: string;
}

export interface LlmGeneralProjectMetaMergeOutput {
  summary: string;
  mergeGroups: LlmGeneralProjectMetaMergeGroup[];
}

export interface LlmDreamClusterHeaderInput {
  relativePath: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface LlmDreamCluster {
  memberRelativePaths: string[];
  reason: string;
}

export interface LlmDreamClusterPlanInput {
  kind: "project" | "feedback";
  headers: LlmDreamClusterHeaderInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterPlanOutput {
  summary: string;
  clusters: LlmDreamCluster[];
}

export interface LlmDreamClusterRefineInput {
  kind: "project" | "feedback";
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterRefineOutput {
  summary: string;
  file: {
    name: string;
    description: string;
    markdown: string;
  } | null;
}

export interface LlmDreamProjectMetaReviewInput {
  currentMeta: LlmDreamFileProjectMetaInput;
  recentProjectRecords: LlmDreamFileRecordInput[];
  recentFeedbackRecords: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamProjectMetaReviewOutput {
  shouldUpdate: boolean;
  reason: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
}

const EXTRACTION_SYSTEM_PROMPT = `
You are a memory indexing engine for a conversational assistant.

Your job is to convert a visible user/assistant conversation into durable memory indexes.

Rules:
- Only use information explicitly present in the conversation.
- Ignore system prompts, tool scaffolding, hidden reasoning, formatting artifacts, and operational chatter.
- Be conservative. If something is ambiguous, omit it.
- Track projects only when they look like a real ongoing effort, task stream, research topic, implementation effort, or recurring problem worth revisiting later.
- "Project" here is broad: it can be a workstream, submission, research effort, health/problem thread, or other ongoing topic the user is likely to revisit.
- If the conversation contains multiple independent ongoing threads, return multiple project items instead of collapsing them into one.
- Repeated caregiving, illness handling, symptom tracking, recovery follow-up, or other ongoing real-world problem-solving threads should be treated as projects when the user is actively managing them.
- Example: "friend has diarrhea / user buys medicine / later reports recovery" is a project-like thread.
- Example: "preparing an EMNLP submission" is another independent project-like thread.
- Do not treat casual one-off mentions as projects.
- Extract facts only when they are likely to matter in future conversations: preferences, constraints, goals, identity, long-lived context, stable relationships, or durable project context.
- The facts are intermediate material for a later global profile rewrite, so prefer stable facts over temporary situation notes.
- Natural-language output fields must use the dominant language of the user messages. If user messages are mixed, prefer the most recent user language. Keys and enums must stay in English.
- Each project summary must be a compact 1-2 sentence project memory, not a generic status line.
- A good project summary should preserve: what the project is, what stage it is in now, and the next step / blocker / missing info when available.
- Do not output vague summaries like "the user is working on this project", "progress is going well", "things are okay", or "handling something" unless the project-specific context is also included.
- latest_progress must stay short and only capture the newest meaningful update, newest blocker, or newest confirmation state.
- Return valid JSON only. No markdown fences, no commentary.

Use this exact JSON shape:
{
  "summary": "short session summary",
  "situation_time_info": "short time-aware progress line",
  "facts": [
    {
      "category": "preference | profile | goal | constraint | relationship | project | context | other",
      "subject": "stable english key fragment",
      "value": "durable fact text",
      "confidence": 0.0
    }
  ],
  "projects": [
    {
      "key": "stable english identifier, lower-kebab-case",
      "name": "project name as the user would recognize it",
      "status": "planned | in_progress | done",
      "summary": "rolling 1-2 sentence summary: what this project is + current phase + next step/blocker when known",
      "latest_progress": "short latest meaningful progress or blocker, without repeating the full project background",
      "confidence": 0.0
    }
  ]
}
`.trim();

const USER_PROFILE_REWRITE_SYSTEM_PROMPT = `
You rewrite the single "身份背景" section of a global user profile for a conversational memory system.

Rules:
- Return JSON only.
- The existing profile markdown is the previous draft. The incoming user notes are the newest evidence.
- Rewrite the section from scratch. Do not append blindly, and do not keep duplicate or near-duplicate facts just because they already exist.
- Keep only durable personal identity/background information that should persist across future sessions.
- If old profile content conflicts with newer, clearer incoming evidence, prefer the newer evidence and rewrite the section accordingly.
- If the incoming evidence only describes reply preferences, formatting habits, style choices, language choices, file/tool boundaries, or project collaboration rules, do not include them in the rewritten section.
- Do not include project progress, project-specific collaboration rules, deadlines, blockers, or temporary tasks.
- Keep the language aligned with the user's language in the incoming content.
- "identity_background_markdown" must contain only the markdown content that belongs under the "## 身份背景" heading.
- Do not include the heading itself.
- Prefer concise bullet-list markdown when possible.

Use this exact JSON shape:
{
  "identity_background_markdown": "- ..."
}
`.trim();

const STABLE_FORMAL_PROJECT_ID_PATTERN = /^project_[a-z0-9]+$/;

const DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT = `
You are the Dream global audit planner for a file-memory system.

Your job is to inspect the current project's metadata and memory files, then produce a single executable reorganization plan for that current project.

Rules:
- Use only the supplied current-project metadata and memory file snapshots as evidence.
- Do not invent projects, files, facts, or merges that are not supported by the provided memory files.
- This runtime has exactly one top-level current project for the active workspace.
- Do not create extra sibling projects, tmp projects, or umbrella projects.
- Decide the final file-level organization for the current project before any rewrite happens.
- Natural-language output fields must follow the dominant language already present in the supplied records and project metas.
- If the supplied evidence is mainly Chinese, write summaries, project_name, description, and any other natural-language output in Chinese.
- Keys and enums must remain in English.
- Multiple Project/*.md and Feedback/*.md files under the current project are expected and correct.
- If two explicit project names appear in the memories, treat them as alternative names, phases, or topic labels inside the same current project unless the evidence clearly says they are unrelated noise that should be deleted.
- You may:
  - rewrite current-project metadata
  - merge redundant files within the current project
  - keep multiple files when they represent distinct durable memories within the current project
  - delete old files only when their durable content is fully absorbed elsewhere
- If you consolidate files that use different project labels inside the same current project, keep project_name user-recognizable.
- Each retained entry id must appear in exactly one output project.
- deleted_entry_ids should only include files that are redundant, superseded, or absorbed by other rewritten files.
- deleted_project_ids should stay empty in current-project mode.
- Keep project names user-recognizable.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short audit summary",
  "duplicate_topic_count": 0,
  "conflict_topic_count": 0,
  "projects": [
    {
      "plan_key": "stable planner-local key",
      "target_project_id": "current_project",
      "project_name": "final project name",
      "description": "final project description",
      "status": "active",
      "merge_reason": "",
      "evidence_entry_ids": ["Project/current-stage.md"],
      "retained_entry_ids": ["Project/foo.md", "Feedback/bar.md"]
    }
  ],
  "deleted_project_ids": [],
  "deleted_entry_ids": ["Feedback/old.md"]
}
`.trim();

const DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT = `
You are the Dream project rewrite engine for a file-memory system.

Your job is to rewrite one final project from the supplied project and feedback memory files.

Rules:
- Use only the supplied records as evidence.
- Do not create a project-level summary file.
- Preserve atomic memory granularity: output a small set of project files and feedback files.
- Merge only when files are clearly redundant or conflicting enough that one cleaner file is better.
- Keep the supplied final project boundary and final project name. Do not broaden it into a more abstract umbrella project.
- Natural-language output fields must follow the dominant language already present in the supplied records and current project meta.
- If the supplied evidence is mainly Chinese, write project_meta fields and all project/feedback body fields in Chinese.
- Keys and enums must remain in English.
- Project files must describe project state: stage, decisions, constraints, next steps, blockers, timeline, notes.
- Feedback files must describe collaboration rules: rule, why, how_to_apply, notes.
- deleted_entry_ids should only include source files that are fully absorbed by rewritten files or are redundant.
- Every rewritten file must cite at least one source_entry_id from the supplied records.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short rewrite summary",
  "project_meta": {
    "project_name": "final project name",
    "description": "final project description",
    "status": "active"
  },
  "files": [
    {
      "type": "project",
      "name": "current-stage",
      "description": "current project state",
      "source_entry_ids": ["Project/a.md"],
      "stage": "current stage",
      "decisions": ["decision"],
      "constraints": ["constraint"],
      "next_steps": ["next step"],
      "blockers": ["blocker"],
      "timeline": ["timeline item"],
      "notes": ["note"]
    },
    {
      "type": "feedback",
      "name": "delivery-rule",
      "description": "delivery preference",
      "source_entry_ids": ["Feedback/b.md"],
      "rule": "the rule",
      "why": "why it matters",
      "how_to_apply": "when to apply it",
      "notes": ["note"]
    }
  ],
  "deleted_entry_ids": ["Project/obsolete.md"]
}
`.trim();

const GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT = `
You are the General Dream project-meta merge planner for a file-memory system.

Your job is to inspect all General project metadata records and decide which project nodes clearly describe the same real project.

Rules:
- Use only the supplied project metadata records as evidence.
- Be conservative. If there is any meaningful uncertainty, do not merge.
- Merge only when multiple project metas clearly refer to the same real project, same ongoing workstream, same external mirrored project identity, or an obvious alias/rename of the same project.
- Do not merge merely because projects share a domain, platform, customer type, content format, date, model, workflow, or broad business category.
- Do not merge separate named workstreams with different goals or deliverables.
- Example: "GBX-A 20260423 HoneydewPulse" and "GBX-B 20260423 ClinicFlow" must remain separate because they name different projects with different targets.
- For external mirrors, matching source_workspace_path plus source_project_id is strong evidence for merging.
- keeper_project_id and every duplicate_project_id must be one of the supplied project ids.
- A project id may appear in at most one merge group.
- The keeper must not appear in duplicate_project_ids.
- Return an empty merge_groups array when no merge is clearly justified.
- Natural-language output fields should follow the dominant language already present in the supplied project metas.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short merge planning summary",
  "merge_groups": [
    {
      "keeper_project_id": "project id to keep",
      "duplicate_project_ids": ["project id to merge into keeper"],
      "reason": "specific evidence that these metas are the same real project"
    }
  ]
}
`.trim();

function buildDreamClusterPlanSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryDescription = kind === "project"
    ? "Project memory files capture durable project facts such as project definition, scope, goals, blockers, risks, and important progress."
    : "Feedback memory files capture durable collaboration rules, delivery rules, style rules, title/body template rules, and confirmed output constraints.";
  return `
You are the ${kindLabel} Dream cluster planner for a file-memory system.

Your job is to inspect lightweight header information only and decide which files should be refined together.

Rules:
- Use only the supplied header metadata as evidence.
- Do not assume full file contents beyond what the header says.
- ${categoryDescription}
- Return mutually exclusive candidate clusters only.
- A file may appear in at most one cluster.
- Only create a cluster when at least two files likely overlap, conflict, or should be merged into one cleaner memory file.
- If files are distinct and should remain separate, leave them out of clusters.
- Files belonging to the same current project is not, by itself, a merge reason.
- Shared workspace, shared project membership, shared domain, or shared topic is not enough unless the headers show concrete semantic overlap, fact conflict, rule duplication, or obvious consolidation value.
- Each cluster reason must name the specific overlap, conflict, repeated rule, repeated fact, or consolidation topic that justifies refinement.
- Keep reasons concise and specific.
- Natural-language output should follow the dominant language already visible in the supplied headers.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short planning summary",
  "clusters": [
    {
      "member_relative_paths": ["Project/a.md", "Project/b.md"],
      "reason": "why these files should be refined together"
    }
  ]
}
`.trim();
}

function buildDreamClusterRefineSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryInstruction = kind === "project"
    ? [
        "Produce exactly one project memory file.",
        "Keep durable project facts only: what the project is, stable scope, goals, important progress, blockers, risks, and important decisions.",
        "Do not reduce the file to a vague status line.",
        "Prefer readable markdown headings such as ## Summary, ## Current Stage, ## Constraints, ## Blockers, ## Next Steps, ## Timeline, ## Notes when useful.",
      ].join("\n- ")
    : [
        "Produce exactly one feedback memory file.",
        "Keep durable collaboration rules only: delivery order, output structure, style constraints, title/body template guidance, and confirmed review preferences.",
        "Prefer readable markdown headings such as ## Rule, ## Why, ## How To Apply, ## Notes when useful.",
      ].join("\n- ");
  return `
You are the ${kindLabel} Dream refine engine for a file-memory system.

Your job is to merge one cluster of existing memory files into exactly one cleaner memory file.

Rules:
- Use only the supplied full file contents as evidence.
- Resolve overlap, deduplicate repeated details, and keep the most useful durable facts.
- Do not invent new facts.
- Output exactly one refined file.
- The visible output language must follow the dominant language already present in the supplied files. If the supplied files are mixed, prefer the dominant language of the cluster.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- ${categoryInstruction}
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short refine summary",
  "name": "refined file title",
  "description": "one-line description",
  "markdown": "full markdown body"
}
`.trim();
}

const DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT = `
You are the Dream project metadata reviewer for a file-memory system.

Your job is to decide whether the current project metadata is clearly incorrect or outdated after project/feedback refinement.

Rules:
- Use only the supplied current metadata and the recent project/feedback files as evidence.
- Be conservative. Keep the current metadata unless the supplied evidence clearly supports a change.
- You may update only:
  - project_name
  - description
  - status
- Do not rewrite metadata just to paraphrase it.
- Natural-language output fields must follow the dominant language already present in the supplied project/feedback files.
- Return valid JSON only.

Use this exact JSON shape:
{
  "should_update": false,
  "reason": "why metadata should or should not change",
  "project_name": "final project name",
  "description": "final description",
  "status": "in_progress"
}
`.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeHeaders(headers: unknown): ProviderHeaders {
  if (!isRecord(headers)) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function parseModelRef(modelRef: string | undefined, config: Record<string, unknown>): { provider: string; model: string } | undefined {
  if (typeof modelRef === "string" && modelRef.includes("/")) {
    const [provider, ...rest] = modelRef.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  const modelsConfig = isRecord(config.models) ? config.models : undefined;
  const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
  if (!providers) return undefined;

  if (typeof modelRef === "string" && modelRef.trim()) {
    const providerEntries = Object.entries(providers);
    if (providerEntries.length === 1) {
      return { provider: providerEntries[0]![0], model: modelRef.trim() };
    }
  }

  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) continue;
    const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    const firstModel = models.find((entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.trim());
    if (firstModel && isRecord(firstModel)) {
      return { provider, model: String(firstModel.id).trim() };
    }
  }
  return undefined;
}

function resolveAgentPrimaryModel(config: Record<string, unknown>, agentId?: string): string | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsModel = defaults && isRecord(defaults.model) ? defaults.model : undefined;

  if (agentId && agents && isRecord(agents[agentId])) {
    const agentConfig = agents[agentId] as Record<string, unknown>;
    const agentModel = isRecord(agentConfig.model) ? agentConfig.model : undefined;
    if (typeof agentModel?.primary === "string" && agentModel.primary.trim()) {
      return agentModel.primary.trim();
    }
  }

  if (typeof defaultsModel?.primary === "string" && defaultsModel.primary.trim()) {
    return defaultsModel.primary.trim();
  }

  return undefined;
}

function detectPreferredOutputLanguage(messages: MemoryMessage[]): string | undefined {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  if (/[\u4e00-\u9fff]/.test(userText)) return "Simplified Chinese";
  return undefined;
}

function buildUserProfileRewritePrompt(input: {
  existingProfile: MemoryUserSummary | null;
  candidates: MemoryCandidate[];
}): string {
  return JSON.stringify({
    existing_profile_markdown: input.existingProfile?.files[0]?.content
      ? truncate(input.existingProfile.files[0].content, 3_200)
      : null,
    incoming_user_notes: input.candidates.map((candidate) => {
      const noteMarkdown = candidate.body || candidate.profile || candidate.summary || candidate.description;
      return {
        description: truncateForPrompt(candidate.description, 180),
        note_markdown: truncate(String(noteMarkdown || ""), 1_400),
        captured_at: candidate.capturedAt ?? "",
        source_session_key: candidate.sourceSessionKey ?? "",
      };
    }),
  }, null, 2);
}

function renderIdentityBackgroundMarkdownFromItems(items: string[]): string {
  const normalized = uniqueStrings(items.map((item) => stripMarkdownSyntax(item)), 20);
  return normalized.map((item) => `- ${item}`).join("\n");
}

function normalizeIdentityBackgroundSectionMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    if (Array.isArray(value)) {
      return renderIdentityBackgroundMarkdownFromItems(
        value.filter((item): item is string => typeof item === "string"),
      ).trim();
    }
    return "";
  }

  let normalized = value
    .replace(/\r/g, "\n")
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  normalized = normalized.replace(/^#{1,6}\s*身份背景\s*\n+/i, "").trim();
  return normalized;
}

function buildUserProfileBodyFromSectionMarkdown(sectionMarkdown: unknown): string | null {
  const normalizedSection = normalizeIdentityBackgroundSectionMarkdown(sectionMarkdown);
  if (!normalizedSection) return null;
  return `## 身份背景\n${normalizedSection.trim()}\n`;
}

function extractIdentityBackgroundFactsFromProfileBody(body: string): string[] {
  return splitProfileFacts(stripMarkdownSyntax(body));
}

function buildRewrittenUserProfileCandidate(input: {
  sectionMarkdown: unknown;
  latestCandidate?: MemoryCandidate;
}): MemoryCandidate | null {
  const body = buildUserProfileBodyFromSectionMarkdown(input.sectionMarkdown);
  if (!body) return null;

  const facts = extractIdentityBackgroundFactsFromProfileBody(body);
  return {
    type: "user",
    scope: "global",
    name: "user-profile",
    description: truncateForPrompt(facts[0] || "User profile", 120),
    ...(input.latestCandidate?.capturedAt ? { capturedAt: input.latestCandidate.capturedAt } : {}),
    ...(input.latestCandidate?.sourceSessionKey ? { sourceSessionKey: input.latestCandidate.sourceSessionKey } : {}),
    body,
    ...(facts.length > 0 ? { profile: facts.join("；") } : {}),
    ...(facts.length > 0 ? { relationships: facts } : {}),
  };
}

function buildConversationTurns(messages: MemoryMessage[]): MemoryMessage[][] {
  const turns: MemoryMessage[][] = [];
  let current: MemoryMessage[] = [];
  for (const message of messages.filter((item) => item.role === "user" || item.role === "assistant")) {
    if (message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (current.length > 0) current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function findFocusTurnIndex(turns: MemoryMessage[][], focusMessage: MemoryMessage): number {
  const byReference = turns.findIndex((turn) => turn.some((message) => message === focusMessage));
  if (byReference >= 0) return byReference;
  const byValue = turns.findIndex((turn) =>
    turn.some((message) => message.role === focusMessage.role && message.content === focusMessage.content));
  return byValue;
}

function serializeTurnsForPrompt(turns: MemoryMessage[][]): Array<{ turn_index: number; messages: Array<{ role: string; content: string }> }> {
  return turns.map((turn, index) => ({
    turn_index: index + 1,
    messages: turn.map((message) => ({
      role: message.role,
      content: truncateForPrompt(message.content, 320),
    })),
  }));
}

function buildIndexPromptWindow(input: {
  batchContextMessages: MemoryMessage[];
  focusUserTurn: MemoryMessage;
  currentProjectMeta?: ProjectMetaRecord | null;
}): string {
  const turns = buildConversationTurns(input.batchContextMessages);
  const focusTurnIndex = findFocusTurnIndex(turns, input.focusUserTurn);
  const focusTurn = focusTurnIndex >= 0
    ? turns[focusTurnIndex]!
    : [input.focusUserTurn];
  const previousTurns = focusTurnIndex >= 0
    ? turns.slice(Math.max(0, focusTurnIndex - 2), focusTurnIndex)
    : [];
  const nextTurns = focusTurnIndex >= 0
    ? turns.slice(focusTurnIndex + 1, focusTurnIndex + 3)
    : [];
  return JSON.stringify({
    current_project_meta: input.currentProjectMeta
      ? {
          project_id: input.currentProjectMeta.projectId,
          project_name: input.currentProjectMeta.projectName,
          description: truncateForPrompt(input.currentProjectMeta.description, 220),
          status: input.currentProjectMeta.status,
          updated_at: input.currentProjectMeta.updatedAt,
        }
      : null,
    focus_user_turn: {
      role: input.focusUserTurn.role,
      content: truncateForPrompt(input.focusUserTurn.content, 400),
    },
    focus_turn_with_neighbor_assistant_context: serializeTurnsForPrompt([focusTurn])[0],
    previous_turns: serializeTurnsForPrompt(previousTurns),
    next_turns: serializeTurnsForPrompt(nextTurns),
  }, null, 2);
}

function normalizeClassificationLabels(value: unknown): MemoryClassificationLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: MemoryClassificationLabel[] = [];
  const seen = new Set<MemoryCreateKind>();
  for (const item of value) {
    const record = isRecord(item) ? item as RawMemoryClassificationLabelPayload : undefined;
    const type = record?.type === "user" || record?.type === "project" || record?.type === "feedback"
      ? record.type
      : undefined;
    if (!type || seen.has(type)) continue;
    seen.add(type);
    labels.push({
      type,
      reason: typeof record?.reason === "string" ? truncateForPrompt(record.reason, 220) : "",
      evidence: typeof record?.evidence === "string" ? truncateForPrompt(record.evidence, 220) : "",
    });
  }
  return labels;
}

function buildCandidateFromCreatePayload(input: {
  kind: MemoryCreateKind;
  payload: RawMemoryCreatePayload;
  timestamp: string;
  sessionKey?: string;
}): MemoryCandidate | null {
  const name = typeof input.payload.name === "string" ? truncateForPrompt(input.payload.name, 80) : "";
  const description = typeof input.payload.description === "string"
    ? truncateForPrompt(input.payload.description, 180)
    : "";
  const markdown = typeof input.payload.markdown === "string" ? input.payload.markdown.trim() : "";
  if (!name || !description || !markdown) return null;
  if (input.kind === "project" && isGenericProjectCandidateName(name)) return null;
  return {
    type: input.kind,
    scope: input.kind === "user" ? "global" : "project",
    name,
    description,
    body: markdown,
    capturedAt: input.timestamp,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
  };
}

function buildDreamFileGlobalPlanPrompt(input: LlmDreamFileGlobalPlanInput): string {
  const currentProjectNames = Array.from(new Set(
    input.currentProjects
      .map((project) => normalizeWhitespace(project.projectName))
      .filter(Boolean),
  ));
  const observedMemoryLabels = Array.from(new Set(
    input.records
      .filter((record) => record.type === "project")
      .map((record) => normalizeWhitespace(record.name))
      .filter(Boolean),
  ));
  return JSON.stringify({
    governance_scope: {
      mode: "dream_file_global_plan",
      workspace_mode: "current_project",
      primary_truth: "existing_file_memories_only",
      writable_targets: ["project.meta.md", "Project/*.md", "Feedback/*.md"],
      forbidden_outputs: ["new project-level summary file", "new summary layer"],
    },
    merge_constraints: {
      current_project_names: currentProjectNames,
      observed_memory_labels: observedMemoryLabels,
      keep_multiple_memory_files_within_current_project: true,
      do_not_create_additional_top_level_projects: true,
    },
    current_projects: input.currentProjects.map((project) => ({
      project_id: project.projectId,
      project_name: project.projectName,
      description: truncateForPrompt(project.description, 220),
      status: project.status,
      updated_at: project.updatedAt,
      dream_updated_at: project.dreamUpdatedAt ?? "",
    })),
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      scope: record.scope,
      project_id: record.projectId ?? "",
      is_tmp: record.isTmp,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      captured_at: record.capturedAt ?? "",
      source_session_key: record.sourceSessionKey ?? "",
      content: truncateForPrompt(record.content, 1200),
      project: record.project
        ? {
            stage: truncateForPrompt(record.project.stage, 220),
            decisions: record.project.decisions.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            constraints: record.project.constraints.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            next_steps: record.project.nextSteps.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            blockers: record.project.blockers.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            timeline: record.project.timeline.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            notes: record.project.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
      feedback: record.feedback
        ? {
            rule: truncateForPrompt(record.feedback.rule, 220),
            why: truncateForPrompt(record.feedback.why, 220),
            how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
            notes: record.feedback.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
    })),
  }, null, 2);
}

function buildDreamFileProjectRewritePrompt(input: LlmDreamFileProjectRewriteInput): string {
  return JSON.stringify({
    governance_scope: {
      mode: "dream_file_project_rewrite",
      primary_truth: "supplied_project_and_feedback_files",
      forbidden_outputs: ["new project-level summary file", "new summary layer"],
      final_project_id: input.project.projectId,
    },
    project: {
      project_id: input.project.projectId,
      plan_key: input.project.planKey,
      project_name: input.project.projectName,
      description: truncateForPrompt(input.project.description, 220),
      status: input.project.status,
      merge_reason: input.project.mergeReason ?? "",
      evidence_entry_ids: input.project.evidenceEntryIds,
      retained_entry_ids: input.project.retainedEntryIds,
    },
    current_meta: input.currentMeta
      ? {
          project_id: input.currentMeta.projectId,
          project_name: input.currentMeta.projectName,
          description: truncateForPrompt(input.currentMeta.description, 220),
          status: input.currentMeta.status,
          updated_at: input.currentMeta.updatedAt,
        }
      : null,
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      is_tmp: record.isTmp,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      content: truncateForPrompt(record.content, 1200),
      project: record.project
        ? {
            stage: truncateForPrompt(record.project.stage, 220),
            decisions: record.project.decisions.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            constraints: record.project.constraints.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            next_steps: record.project.nextSteps.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            blockers: record.project.blockers.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            timeline: record.project.timeline.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
            notes: record.project.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
      feedback: record.feedback
        ? {
            rule: truncateForPrompt(record.feedback.rule, 220),
            why: truncateForPrompt(record.feedback.why, 220),
            how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
            notes: record.feedback.notes.map((item) => truncateForPrompt(item, 140)).slice(0, 12),
          }
        : undefined,
    })),
  }, null, 2);
}

function buildDreamClusterPlanPrompt(input: LlmDreamClusterPlanInput): string {
  return JSON.stringify({
    category: input.kind,
    headers: input.headers.map((header) => ({
      relative_path: header.relativePath,
      name: truncateForPrompt(header.name, 120),
      description: truncateForPrompt(header.description, 220),
      updated_at: header.updatedAt,
    })),
  }, null, 2);
}

function buildDreamClusterRefinePrompt(input: LlmDreamClusterRefineInput): string {
  return JSON.stringify({
    category: input.kind,
    records: input.records.map((record) => ({
      entry_id: record.entryId,
      relative_path: record.relativePath,
      type: record.type,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      captured_at: record.capturedAt ?? "",
      source_session_key: record.sourceSessionKey ?? "",
      content: record.content,
    })),
  }, null, 2);
}

function buildDreamProjectMetaReviewPrompt(input: LlmDreamProjectMetaReviewInput): string {
  return JSON.stringify({
    current_project_meta: {
      project_id: input.currentMeta.projectId,
      project_name: input.currentMeta.projectName,
      description: truncateForPrompt(input.currentMeta.description, 220),
      status: input.currentMeta.status,
      updated_at: input.currentMeta.updatedAt,
      dream_updated_at: input.currentMeta.dreamUpdatedAt ?? "",
    },
    recent_project_files: input.recentProjectRecords.map((record) => ({
      relative_path: record.relativePath,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      content: record.content,
    })),
    recent_feedback_files: input.recentFeedbackRecords.map((record) => ({
      relative_path: record.relativePath,
      name: record.name,
      description: truncateForPrompt(record.description, 220),
      updated_at: record.updatedAt,
      content: record.content,
    })),
  }, null, 2);
}

function buildGeneralProjectMetaMergePrompt(input: LlmGeneralProjectMetaMergeInput): string {
  return JSON.stringify({
    governance_scope: {
      mode: "general_project_meta_merge_plan",
      primary_truth: "supplied_general_project_meta_only",
      writable_targets: ["GeneralProjects/*.md"],
      forbidden_outputs: ["new project meta", "project memory rewrite", "feedback memory rewrite", "user profile rewrite"],
    },
    project_metas: input.projectMetas.map((project) => ({
      project_id: project.projectId,
      project_name: project.projectName,
      description: truncateForPrompt(project.description, 260),
      status: project.status,
      updated_at: project.updatedAt,
      dream_updated_at: project.dreamUpdatedAt ?? "",
      source_kind: project.sourceKind ?? "",
      source_workspace_path: project.sourceWorkspacePath ?? "",
      source_project_id: project.sourceProjectId ?? "",
    })),
  }, null, 2);
}

function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in extraction response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }

  throw new Error("Incomplete JSON object in extraction response");
}

function extractLooseJsonEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("No JSON envelope found in extraction response");
  }
  return trimmed.slice(start, end + 1);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeLooseJsonString(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function extractLooseJsonBooleanProperty(source: string, key: string): boolean | undefined {
  const match = source.match(new RegExp(`"${escapeRegexLiteral(key)}"\\s*:\\s*(true|false)`, "i"));
  if (!match) return undefined;
  return match[1]?.toLowerCase() === "true";
}

function extractLooseJsonStringProperty(
  source: string,
  key: string,
  nextKeys: string[],
): string | undefined {
  const escapedKey = escapeRegexLiteral(key);
  const nextKeyPattern = nextKeys.map((item) => escapeRegexLiteral(item)).join("|");
  const pattern = nextKeys.length > 0
    ? new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"(${nextKeyPattern})"\\s*:`, "i")
    : new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)"\\s*}\\s*$`, "i");
  const match = source.match(pattern);
  return match?.[1] ? decodeLooseJsonString(match[1]) : undefined;
}

function tryParseLooseMemoryCreatePayload(raw: string): RawMemoryCreatePayload | null {
  const envelope = extractLooseJsonEnvelope(raw);
  const payload: RawMemoryCreatePayload = {
    ...(extractLooseJsonBooleanProperty(envelope, "skip") !== undefined
      ? { skip: extractLooseJsonBooleanProperty(envelope, "skip") }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"])
      ? { reason: extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"])
      ? { name: extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "description", ["markdown"])
      ? { description: extractLooseJsonStringProperty(envelope, "description", ["markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "markdown", [])
      ? { markdown: extractLooseJsonStringProperty(envelope, "markdown", []) }
      : {}),
  };
  return typeof payload.name === "string" && typeof payload.description === "string" && typeof payload.markdown === "string"
    ? payload
    : null;
}

function slugifyKeyPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeDreamFileProjectId(value: unknown, allowedProjectIds: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value);
  return normalized && allowedProjectIds.has(normalized) ? normalized : undefined;
}

function normalizeDreamFileEntryIds(items: unknown, allowedEntryIds: ReadonlySet<string>, maxItems = 200): string[] {
  if (!Array.isArray(items)) return [];
  return Array.from(new Set(
    items
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeWhitespace(item))
      .filter((item) => item && allowedEntryIds.has(item)),
  )).slice(0, maxItems);
}

function normalizeDreamFileProjectStatus(value: unknown): string {
  const normalized = typeof value === "string" ? normalizeWhitespace(value) : "";
  return truncate(normalized || "active", 80);
}

function normalizeDreamFileMergeReason(
  value: unknown,
): "rename" | "alias_equivalence" | "duplicate_formal_project" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeWhitespace(value).toLowerCase();
  switch (normalized) {
    case "rename":
    case "alias_equivalence":
    case "duplicate_formal_project":
      return normalized;
    default:
      return undefined;
  }
}

function normalizeDreamFileGlobalPlanProject(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
  allowedProjectIds: ReadonlySet<string>,
  fallbackIndex: number,
): LlmDreamFileGlobalPlanProject | null {
  if (!isRecord(item)) return null;
  const retainedEntryIds = normalizeDreamFileEntryIds(item.retained_entry_ids, allowedEntryIds, 400);
  if (retainedEntryIds.length === 0) return null;
  const planKey = typeof item.plan_key === "string"
    ? truncate(normalizeWhitespace(item.plan_key), 120)
    : `dream-plan-${fallbackIndex + 1}`;
  const projectName = typeof item.project_name === "string"
    ? truncate(normalizeWhitespace(item.project_name), 120)
    : "";
  const description = typeof item.description === "string"
    ? truncate(normalizeWhitespace(item.description), 320)
    : "";
  if (!projectName || !description) return null;
  const targetProjectId = normalizeDreamFileProjectId(item.target_project_id, allowedProjectIds);
  const mergeReason = normalizeDreamFileMergeReason(item.merge_reason);
  return {
    planKey,
    ...(targetProjectId ? { targetProjectId } : {}),
    projectName,
    description,
    status: normalizeDreamFileProjectStatus(item.status),
    ...(mergeReason ? { mergeReason } : {}),
    evidenceEntryIds: normalizeDreamFileEntryIds(item.evidence_entry_ids, allowedEntryIds, 80),
    retainedEntryIds,
  };
}

function normalizeDreamFileProjectMetaPayload(
  value: unknown,
  fallback: { projectName: string; description: string; status: string },
): { projectName: string; description: string; status: string } {
  if (!isRecord(value)) return fallback;
  const projectName = typeof value.project_name === "string"
    ? truncate(normalizeWhitespace(value.project_name), 120)
    : fallback.projectName;
  const description = typeof value.description === "string"
    ? truncate(normalizeWhitespace(value.description), 320)
    : fallback.description;
  return {
    projectName: projectName || fallback.projectName,
    description: description || fallback.description,
    status: normalizeDreamFileProjectStatus(value.status ?? fallback.status),
  };
}

function normalizeDreamFileProjectRewriteFile(
  item: unknown,
  allowedEntryIds: ReadonlySet<string>,
): LlmDreamFileProjectRewriteOutputFile | null {
  if (!isRecord(item)) return null;
  const type = item.type === "project" || item.type === "feedback" ? item.type : null;
  if (!type) return null;
  const sourceEntryIds = normalizeDreamFileEntryIds(item.source_entry_ids, allowedEntryIds, 200);
  if (sourceEntryIds.length === 0) return null;
  const name = typeof item.name === "string" ? truncate(normalizeWhitespace(item.name), 120) : "";
  const description = typeof item.description === "string" ? truncate(normalizeWhitespace(item.description), 320) : "";
  if (!name || !description) return null;
  if (type === "project") {
    const stage = typeof item.stage === "string" ? truncate(normalizeWhitespace(item.stage), 220) : "";
    return {
      type,
      name,
      description,
      sourceEntryIds,
      ...(stage ? { stage } : {}),
      decisions: uniqueStrings(normalizeStringArray(item.decisions, 20), 20),
      constraints: uniqueStrings(normalizeStringArray(item.constraints, 20), 20),
      nextSteps: uniqueStrings(normalizeStringArray(item.next_steps, 20), 20),
      blockers: uniqueStrings(normalizeStringArray(item.blockers, 20), 20),
      timeline: uniqueStrings(normalizeStringArray(item.timeline, 20), 20),
      notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
    };
  }
  const rule = typeof item.rule === "string" ? truncate(normalizeWhitespace(item.rule), 320) : "";
  if (!rule) return null;
  return {
    type,
    name,
    description,
    sourceEntryIds,
    rule,
    ...(typeof item.why === "string" && normalizeWhitespace(item.why)
      ? { why: truncate(normalizeWhitespace(item.why), 320) }
      : {}),
    ...(typeof item.how_to_apply === "string" && normalizeWhitespace(item.how_to_apply)
      ? { howToApply: truncate(normalizeWhitespace(item.how_to_apply), 320) }
      : {}),
    notes: uniqueStrings(normalizeStringArray(item.notes, 20), 20),
  };
}

function normalizeDreamCluster(
  item: unknown,
  allowedRelativePaths: ReadonlySet<string>,
): LlmDreamCluster | null {
  if (!isRecord(item)) return null;
  const memberRelativePaths = normalizeDreamFileEntryIds(item.member_relative_paths, allowedRelativePaths, 32);
  if (memberRelativePaths.length === 0) return null;
  const reason = typeof item.reason === "string"
    ? truncate(normalizeWhitespace(item.reason), 320)
    : "";
  return {
    memberRelativePaths,
    reason,
  };
}

function normalizeGeneralProjectMetaMergeGroup(item: unknown): LlmGeneralProjectMetaMergeGroup | null {
  if (!isRecord(item)) return null;
  const keeperProjectId = typeof item.keeper_project_id === "string"
    ? normalizeWhitespace(item.keeper_project_id)
    : "";
  const duplicateProjectIds = normalizeStringArray(item.duplicate_project_ids, 100)
    .map((projectId) => normalizeWhitespace(projectId))
    .filter(Boolean);
  if (!keeperProjectId || duplicateProjectIds.length === 0) return null;
  const reason = typeof item.reason === "string"
    ? truncate(normalizeWhitespace(item.reason), 320)
    : "";
  return {
    keeperProjectId,
    duplicateProjectIds: Array.from(new Set(duplicateProjectIds)),
    reason,
  };
}

function normalizeDreamProjectMetaReview(
  payload: RawProjectMetaReviewPayload,
  fallback: { projectName: string; description: string; status: string },
): LlmDreamProjectMetaReviewOutput {
  return {
    shouldUpdate: normalizeBoolean(payload.should_update, false),
    reason: typeof payload.reason === "string"
      ? truncate(normalizeWhitespace(payload.reason), 320)
      : "",
    projectMeta: {
      projectName: typeof payload.project_name === "string"
        ? truncate(normalizeWhitespace(payload.project_name), 120) || fallback.projectName
        : fallback.projectName,
      description: typeof payload.description === "string"
        ? truncate(normalizeWhitespace(payload.description), 320) || fallback.description
        : fallback.description,
      status: normalizeDreamFileProjectStatus(payload.status ?? fallback.status),
    },
  };
}

function truncateForPrompt(value: string, maxLength: number): string {
  return truncate(normalizeWhitespace(value), maxLength);
}

function recallProjectSourcePriority(project: ProjectShortlistCandidate): number {
  if (project.sourceType === "general_local" || project.sourceType === "workspace_external_mirror") return 2;
  if (project.sourceType === "workspace_external") return 1;
  return 0;
}

function chooseBestRecallProjectFallback(shortlist: ProjectShortlistCandidate[]): ProjectShortlistCandidate {
  return [...shortlist].sort((left, right) => {
    if (right.exact !== left.exact) return right.exact - left.exact;
    if (right.score !== left.score) return right.score - left.score;
    const sourcePriorityDelta = recallProjectSourcePriority(right) - recallProjectSourcePriority(left);
    if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0] ?? shortlist[0];
}

function normalizeStringArray(items: unknown, maxItems: number): string[] {
  if (typeof items === "string" && items.trim()) {
    return [items.trim()].slice(0, maxItems);
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueStrings(items: readonly string[], maxItems: number): string[] {
  return Array.from(new Set(
    items
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, maxItems);
}

function pickLongest(left: string, right: string): string {
  const a = normalizeWhitespace(left);
  const b = normalizeWhitespace(right);
  if (!a) return b;
  if (!b) return a;
  return b.length >= a.length ? b : a;
}

function stripExplicitRememberLead(text: string): string {
  return normalizeWhitespace(text);
}

function splitPreferenceHints(text: string): string[] {
  const normalized = text
    .replace(/\r/g, "\n")
    .replace(/[：:]/g, "\n")
    .replace(/[；;]/g, "\n")
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return Array.from(new Set(
    normalized
      .map((line) => stripExplicitRememberLead(line))
      .filter(Boolean)
      .filter((line) => line.length >= 4),
  )).slice(0, 10);
}

function splitProfileFacts(text: string): string[] {
  return uniqueStrings(
    text
      .replace(/\r/g, "\n")
      .split(/\n|[，,；;。.!?]/)
      .map((line) => normalizeWhitespace(line))
      .filter((line) => line.length >= 2),
    20,
  );
}

function stripMarkdownSyntax(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/\r/g, "\n")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*[-*+]\s*/gm, "")
      .replace(/`+/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1"),
  );
}

function isStableFormalProjectId(value: string | undefined): boolean {
  return STABLE_FORMAL_PROJECT_ID_PATTERN.test((value ?? "").trim());
}

function canonicalizeUserFact(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[，。；;,:：.!?]/g, "")
    .replace(/^技术栈常用/, "常用")
    .replace(/^主要使用/, "使用")
    .replace(/^我(?:现在)?常用/, "常用")
    .replace(/^我(?:平时)?更?习惯(?:使用)?/, "习惯")
    .replace(/^习惯(?:使用)?/, "习惯")
    .replace(/^使用/, "")
    .replace(/\s+/g, "");
}

function dedupeFactsAgainstSection(items: string[], excluded: string[]): string[] {
  const excludedKeys = new Set(excluded.map((item) => canonicalizeUserFact(item)).filter(Boolean));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const normalized = normalizeWhitespace(item);
    const key = canonicalizeUserFact(normalized);
    if (!normalized || !key || excludedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }
  return next;
}

function normalizeUserSectionItems(value: unknown, maxItems: number): string[] {
  if (typeof value === "string") {
    return splitProfileFacts(stripMarkdownSyntax(value)).slice(0, maxItems);
  }
  return normalizeStringArray(value, maxItems);
}

function cleanUserIdentitySummary(input: {
  identityBackground: string[];
}): {
  identityBackground: string[];
} {
  return {
    identityBackground: uniqueStrings(
      input.identityBackground.flatMap((item) => splitProfileFacts(stripMarkdownSyntax(item))),
      20,
    ),
  };
}

function looksLikeCollaborationRuleText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  return /(以后回答|回答时|回复时|同步进展|代码示例|先给结论|先说完成了什么|不要写成|怎么和我协作|怎么交付|怎么汇报|请你|交付时|汇报|review|评审|写法|输出格式|回复格式|格式化输出)/i
    .test(normalized)
    || /((给我|你|请按|每次).{0,12}(交付|输出|回复|汇报).{0,20}(标题|正文|封面文案))|((先给|再给).{0,12}(标题|正文|封面文案))/i
      .test(normalized);
}

function deriveFeedbackCandidateName(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (/(交付|标题|正文|封面文案)/i.test(normalized)) return "delivery-rule";
  if (/(汇报|同步进展|风险|完成了什么)/i.test(normalized)) return "reporting-rule";
  if (/(格式|风格|写法|回复时|回答时)/i.test(normalized)) return "format-rule";
  return "collaboration-rule";
}

function looksLikeConcreteProjectMemoryText(text: string): boolean {
  return /(目标是|当前卡点|里程碑|要出可演示版本|要给团队试用|阶段|进展|deadline|blocker|next step|版本|试用|发布|第一版|只做|先做|不碰|约束|限制|一期范围|当前范围|保留|新增一级|memory tab|当前风险|跨会话召回|project\.meta|当前 project)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectRiskText(text: string): boolean {
  return /(当前风险|风险是|主要风险|核心风险|跨会话召回|project\.meta|当前 project|召回[^。；;\n]*project|召回[^。；;\n]*当前项目)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectScopeText(text: string): boolean {
  return /(一期范围|当前范围|本期范围|替换旧记忆|保留[^。；;\n]*(?:memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)|新增一级[^。；;\n]*memory tab|新增[^。；;\n]*memory tab|memory_overview|memory_list|memory_search|memory_get|memory_flush|memory_dream)/i
    .test(normalizeWhitespace(text));
}

function looksLikeProjectFollowUpText(text: string): boolean {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return false;
  return /(接下来|下一步|下个阶段|最该补|还差|先做|先把|优先|先补|最优先|当前卡点|卡点|阻塞|受众|定位|内容角度|角度|约束|限制|不要碰|别碰|统一成|模板化|目标人群|适合打给|更适合打给|核心约束|镜头顺序|标题锚点|开头三秒)/i
    .test(normalized);
}

function looksLikeProjectNextStepText(text: string): boolean {
  return /(接下来|下一步|最该补|还差|先做|先把|优先|先补|最优先)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectConstraintText(text: string): boolean {
  return /(约束|限制|不要|别碰|统一成|模板化|必须|只能|先别|不碰)/i.test(normalizeWhitespace(text));
}

function looksLikeProjectBlockerText(text: string): boolean {
  return /(卡点|阻塞|难点|问题在于|麻烦是|还差)/i.test(normalizeWhitespace(text));
}

function extractUniqueBatchProjectName(messages: MemoryMessage[]): string {
  const names = new Map<string, string>();
  for (const message of messages.filter((entry) => entry.role === "user")) {
    const value = extractProjectNameHint(message.content);
    if (!value) continue;
    const key = value.toLowerCase();
    if (!names.has(key)) names.set(key, value);
  }
  return names.size === 1 ? Array.from(names.values())[0] ?? "" : "";
}

function extractProjectDescriptorHint(text: string): string {
  const patterns = [
    /(?:它|这个项目|该项目|项目)\s*是(?:一个)?\s*([^。；;\n，,]+)/i,
    /(?:这是|这会是)(?:一个)?\s*([^。；;\n，,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncateForPrompt(value, 220);
  }
  return "";
}

function extractProjectStageHint(text: string): string {
  const normalized = normalizeWhitespace(stripExplicitRememberLead(text));
  if (!normalized) return "";
  const patterns = [
    /((?:目前|现在|当前)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:还在|正在|处于)[^。；;\n，,]*?(?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:目前|现在|当前|还在|正在|处于)[^。；;\n，,]*?(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:[^。；;\n，,]{0,24})(?:验证阶段|摸索阶段|试水阶段))/i,
    /((?:设计阶段|开发阶段|测试阶段|规划阶段|调研阶段|原型阶段|实现阶段|上线阶段))/i,
    /((?:验证阶段|摸索阶段|试水阶段))/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? truncateForPrompt(normalizeWhitespace(match[1]), 220) : "";
    if (value) return value;
  }
  return "";
}

function extractProjectNameHint(text: string): string {
  const patterns = [
    /(?:先叫它|先叫|叫它|叫做|项目名(?:字)?(?:先)?叫(?:做)?)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
    /项目[，, ]*(?:先)?叫(?:做)?\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function hasGenericProjectAnchor(text: string): boolean {
  return /(?:这个项目|该项目|本项目|这个东西|这件事)/i.test(normalizeWhitespace(text));
}

function projectIdentityTerms(project: ProjectIdentityHint): string[] {
  return uniqueStrings(
    [project.projectName]
      .map((item) => normalizeWhitespace(item).toLowerCase())
      .filter((item) => item.length > 0 && item.length <= 80 && !/[。！？!?]/.test(item)),
    20,
  );
}

function selectKnownProjectHint(text: string, knownProjects: ProjectIdentityHint[]): ProjectIdentityHint | undefined {
  if (knownProjects.length === 0) return undefined;
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return undefined;
  const exactMatches = knownProjects.filter((project) =>
    projectIdentityTerms(project).some((term) => term && normalized.includes(term)),
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  const projectFollowUpSignal = (
    hasGenericProjectAnchor(text)
    || looksLikeProjectFollowUpText(text)
    || looksLikeConcreteProjectMemoryText(text)
    || looksLikeProjectRiskText(text)
    || looksLikeProjectScopeText(text)
  );
  if (knownProjects.length === 1 && projectFollowUpSignal) {
    return knownProjects[0];
  }
  return undefined;
}

function isGenericProjectCandidateName(name: string): boolean {
  const normalized = normalizeWhitespace(name).toLowerCase();
  return normalized === "" || ["overview", "project", "project-item", "memory-item"].includes(normalized);
}

function isLikelyHumanReadableProjectIdentifier(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (isStableFormalProjectId(normalized)) return false;
  if (isGenericProjectCandidateName(normalized)) return false;
  return normalized.length >= 2 && normalized.length <= 80;
}

function extractProjectNameFromContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return "";
  const patterns = [
    /(?:项目名称|项目名|名称)\s*[:：]\s*([^\n。；;，,（）()]{2,80})/i,
    /(?:项目是|项目叫|先叫)\s*[“"'《]?([^。；;\n，,：:（）()]{2,80})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1] ? normalizeWhitespace(match[1]) : "";
    if (value) return truncate(value, 80);
  }
  return "";
}

function sanitizeProjectDescriptionText(text: string, projectName: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return "";
  let next = normalized
    .replace(/^(?:项目名称|项目名|名称)\s*[:：]\s*/i, "")
    .replace(/^(?:项目叫|项目是|先叫)\s*/i, "");
  if (projectName) {
    const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next
      .replace(new RegExp(`^${escaped}\\s*[（(][^)）]+[)）]?[:：]?\\s*`), "")
      .replace(new RegExp(`^${escaped}[:：]?\\s*`), "");
  }
  next = next.replace(/^[：:，,。；;\s]+/, "");
  return truncateForPrompt(normalizeWhitespace(next), 180);
}

function extractTimelineHints(text: string): string[] {
  const lines = text
    .replace(/\r/g, "\n")
    .split(/\n|(?<=[。！？!?])/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return Array.from(new Set(lines.filter((line) => /\b20\d{2}-\d{2}-\d{2}\b/.test(line)))).slice(0, 10);
}

function extractSingleHint(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match?.[1] ? truncateForPrompt(match[1], 220) : "";
}

function sanitizeFeedbackSectionText(value: string | undefined): string {
  const normalized = normalizeWhitespace(value ?? "");
  if (!normalized) return "";
  if ([
    /explicit project collaboration preference captured from the user/i,
    /project anchor is not formalized yet/i,
    /project-local collaboration instruction without a formal project id yet/i,
    /project-local collaboration instruction for the current project/i,
    /project-local collaboration rule rather than a standalone project memory/i,
    /follow this collaboration rule in future project replies unless the user overrides it/i,
    /apply this rule only after dream attaches it to a formal project context/i,
    /keep it in temporary project memory until dream can attach it to the right project/i,
    /apply this rule in the current project context/i,
    /keep this as current-project feedback memory/i,
  ].some((pattern) => pattern.test(normalized))) {
    return "";
  }
  return normalized;
}

function buildSyntheticProjectFollowUpCandidate(input: {
  focusText: string;
  timestamp: string;
  sessionKey?: string;
  uniqueBatchProjectName: string;
  explicitProjectName: string;
  explicitProjectDescriptor: string;
  explicitProjectStage: string;
  explicitTimeline: string[];
  explicitGoal: string;
  explicitBlocker: string;
}): MemoryCandidate | null {
  const normalizedFocus = truncateForPrompt(normalizeWhitespace(stripExplicitRememberLead(input.focusText)), 220);
  if (!normalizedFocus) return null;
  const projectName = truncateForPrompt(input.explicitProjectName || input.uniqueBatchProjectName, 80);
  if (!projectName || isGenericProjectCandidateName(projectName)) return null;
  const description = truncateForPrompt(
    input.explicitProjectDescriptor
      || input.explicitGoal
      || input.explicitProjectStage
      || normalizedFocus,
    180,
  );
  const projectScopeSignal = looksLikeProjectScopeText(normalizedFocus);
  const projectRiskSignal = looksLikeProjectRiskText(normalizedFocus);
  return {
    type: "project",
    scope: "project",
    name: projectName,
    description,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
    capturedAt: input.timestamp,
    ...(input.explicitProjectStage ? { stage: input.explicitProjectStage } : {}),
    ...(projectScopeSignal ? { decisions: [normalizedFocus] } : {}),
    ...(looksLikeProjectConstraintText(normalizedFocus) ? { constraints: [normalizedFocus] } : {}),
    ...(looksLikeProjectNextStepText(normalizedFocus) ? { nextSteps: [normalizedFocus] } : {}),
    ...(input.explicitBlocker || looksLikeProjectBlockerText(normalizedFocus) || projectRiskSignal
      ? { blockers: uniqueStrings([input.explicitBlocker, normalizedFocus].filter(Boolean), 4) }
      : {}),
    ...(input.explicitTimeline.length > 0 ? { timeline: input.explicitTimeline } : {}),
    notes: projectScopeSignal || projectRiskSignal ? [] : [normalizedFocus],
  };
}

function normalizeMemoryRoute(value: unknown): MemoryRoute {
  if (value === "user" || value === "project" || value === "mix" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function uniqueById<T>(items: T[], getId: (item: T) => string): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(item);
  }
  return next;
}

function fallbackEvidenceNote(lines: string[], fallback = ""): string {
  const normalized = lines
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 8);
  const joined = normalized.join("\n");
  return truncate(joined || normalizeWhitespace(fallback), 800);
}

function extractChatCompletionsText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("Invalid chat completions payload");
  }
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("Missing chat completion message");
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  throw new Error("Unsupported chat completion content shape");
}

function extractResponsesText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Invalid responses payload");
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload.output)) throw new Error("Responses payload missing output");

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Responses payload did not contain text");
  return text;
}

function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

export class LlmMemoryExtractor {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly runtime: Record<string, unknown> | undefined,
    private readonly logger?: LoggerLike,
  ) {}

  private resolveSelection(agentId?: string): ModelSelection {
    const modelRef = resolveAgentPrimaryModel(this.config, agentId);
    const parsed = parseModelRef(modelRef, this.config);
    if (!parsed) throw new Error("Could not resolve an OpenClaw model for memory extraction");

    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig = providers && isRecord(providers[parsed.provider])
      ? providers[parsed.provider] as Record<string, unknown>
      : undefined;
    const configuredModel = Array.isArray(providerConfig?.models)
      ? providerConfig.models.find((item) => isRecord(item) && item.id === parsed.model)
      : undefined;
    const modelConfig = isRecord(configuredModel) ? configuredModel : undefined;

    const api = typeof modelConfig?.api === "string"
      ? modelConfig.api
      : typeof providerConfig?.api === "string"
        ? providerConfig.api
        : "openai-completions";
    const baseUrl = typeof modelConfig?.baseUrl === "string"
      ? modelConfig.baseUrl
      : typeof providerConfig?.baseUrl === "string"
        ? providerConfig.baseUrl
        : undefined;
    const headers = {
      ...sanitizeHeaders(providerConfig?.headers),
      ...sanitizeHeaders(modelConfig?.headers),
    };

    const selection: ModelSelection = {
      provider: parsed.provider,
      model: parsed.model,
      api,
    };
    if (baseUrl?.trim()) selection.baseUrl = stripTrailingSlash(baseUrl.trim());
    if (Object.keys(headers).length > 0) selection.headers = headers;
    return selection;
  }

  private async resolveApiKey(provider: string): Promise<string> {
    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig = providers && isRecord(providers[provider])
      ? providers[provider] as Record<string, unknown>
      : undefined;
    const configured = typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
    if (configured) {
      if (looksLikeEnvVarName(configured) && typeof process.env[configured] === "string" && process.env[configured]?.trim()) {
        return process.env[configured]!.trim();
      }
      return configured;
    }

    const modelAuth = this.runtime && isRecord(this.runtime.modelAuth)
      ? this.runtime.modelAuth as Record<string, unknown>
      : undefined;
    const resolver = typeof modelAuth?.resolveApiKeyForProvider === "function"
      ? modelAuth.resolveApiKeyForProvider as (params: { provider: string; cfg?: Record<string, unknown> }) => Promise<{ apiKey?: string }>
      : undefined;
    if (resolver) {
      const auth = await resolver({ provider, cfg: this.config });
      if (auth?.apiKey && String(auth.apiKey).trim()) {
        return String(auth.apiKey).trim();
      }
    }

    throw new Error(`No API key resolved for extraction provider "${provider}"`);
  }

  private async callStructuredJson(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
  }): Promise<string> {
    const selection = this.resolveSelection(input.agentId);
    if (!selection.baseUrl) {
      throw new Error(`${input.requestLabel} provider "${selection.provider}" does not have a baseUrl`);
    }
    const apiKey = await this.resolveApiKey(selection.provider);
    const headers = new Headers(selection.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
    const apiType = selection.api.trim().toLowerCase();
    let url = "";
    let body: Record<string, unknown>;

    if (apiType === "openai-responses" || apiType === "responses") {
      url = `${selection.baseUrl}/responses`;
      body = {
        model: selection.model,
        temperature: 0,
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    } else {
      url = `${selection.baseUrl}/chat/completions`;
      body = {
        model: selection.model,
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    }

    const executeOnce = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const timeoutMs = resolveRequestTimeoutMs(input.timeoutMs);
      const timeoutId = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payloadBody),
          signal: controller.signal,
        });
      } catch (error) {
        if (timeoutMs !== null && error instanceof Error && error.name === "AbortError") {
          throw new Error(`${input.requestLabel} request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    const executeWithRetry = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < DEFAULT_REQUEST_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await executeOnce(payloadBody);
          if (response.ok) return response;
          const errorText = await response.text();
          const error = Object.assign(
            new Error(`${input.requestLabel} request failed (${response.status}): ${truncate(errorText, 300)}`),
            { status: response.status },
          );
          lastError = error;
          if (!REQUEST_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        } catch (error) {
          lastError = error;
          if (!isTransientRequestError(error) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        }
        await sleep(computeRetryDelayMs(attempt));
      }
      throw lastError instanceof Error ? lastError : new Error(`${input.requestLabel} request failed`);
    };

    let response: Response;
    try {
      response = await executeWithRetry(body);
    } catch (error) {
      if (!("response_format" in body)) throw error;
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      response = await executeWithRetry(fallbackBody);
    }

    const payload = await response.json();
    return apiType === "openai-responses" || apiType === "responses"
      ? extractResponsesText(payload)
      : extractChatCompletionsText(payload);
  }

  private async callStructuredJsonWithDebug<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    parse: (raw: string) => T;
  }): Promise<T> {
    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson(input);
      const parsedResult = input.parse(rawResponse);
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        parsedResult,
      });
      return parsedResult;
    } catch (error) {
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async rewriteUserProfile(input: {
    existingProfile: MemoryUserSummary | null;
    candidates: MemoryCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    const userCandidates = input.candidates.filter((candidate) => candidate.type === "user");
    if (userCandidates.length === 0) return null;

    const latestCandidate = userCandidates[userCandidates.length - 1];
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawUserProfilePayload>({
        systemPrompt: USER_PROFILE_REWRITE_SYSTEM_PROMPT,
        userPrompt: buildUserProfileRewritePrompt(input),
        requestLabel: "User profile rewrite",
        timeoutMs: input.timeoutMs ?? DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawUserProfilePayload,
      });
      return buildRewrittenUserProfileCandidate({
        sectionMarkdown: parsed.identity_background_markdown ?? parsed.identity_background ?? "",
        latestCandidate,
      });
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] user profile rewrite failed: ${String(error)}`);
    }

    return null;
  }

  async classifyMemoryTurn(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<FileMemoryClassificationResult> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawMemoryClassificationPayload>({
        systemPrompt: MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
        userPrompt: buildIndexPromptWindow({
          batchContextMessages: input.batchContextMessages,
          focusUserTurn: input.focusUserTurn,
          currentProjectMeta: input.currentProjectMeta,
        }),
        requestLabel: "Memory turn classification",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawMemoryClassificationPayload,
      });
      const labels = normalizeClassificationLabels(parsed.labels);
      const shouldStore = Boolean(parsed.should_store) && labels.length > 0;
      return { shouldStore, labels };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] memory turn classification fallback: ${String(error)}`);
      return { shouldStore: false, labels: [] };
    }
  }

  private async createMemoryNote(input: {
    kind: MemoryCreateKind;
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    const requestLabel = input.kind === "user"
      ? "User memory create"
      : input.kind === "project"
        ? "Project memory create"
        : "Feedback memory create";
    const systemPrompt = input.kind === "user"
      ? USER_NOTE_CREATE_SYSTEM_PROMPT
      : input.kind === "project"
        ? PROJECT_NOTE_CREATE_SYSTEM_PROMPT
        : FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT;
    const userPrompt = JSON.stringify({
      classification: {
        type: input.classification.type,
        reason: input.classification.reason,
        evidence: input.classification.evidence,
      },
      context: JSON.parse(buildIndexPromptWindow({
        batchContextMessages: input.batchContextMessages,
        focusUserTurn: input.focusUserTurn,
        currentProjectMeta: input.currentProjectMeta,
      })),
    }, null, 2);

    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson({
        systemPrompt,
        userPrompt,
        requestLabel,
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      let parsed: RawMemoryCreatePayload;
      let parseMode: "strict" | "fallback" = "strict";
      let strictParseError = "";
      try {
        parsed = JSON.parse(extractFirstJsonObject(rawResponse)) as RawMemoryCreatePayload;
      } catch (error) {
        strictParseError = error instanceof Error ? error.message : String(error);
        const fallback = tryParseLooseMemoryCreatePayload(rawResponse);
        if (!fallback) throw error;
        parsed = fallback;
        parseMode = "fallback";
      }
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        parsedResult: parseMode === "strict"
          ? parsed
          : {
              parseMode,
              strictParseError,
              payload: parsed,
            },
      });
      if (parsed.skip === true) return null;
      return buildCandidateFromCreatePayload({
        kind: input.kind,
        payload: parsed,
        timestamp: input.timestamp,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      });
    } catch (error) {
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.logger?.warn?.(`[clawxmemory] ${requestLabel.toLowerCase()} fallback: ${String(error)}`);
      return null;
    }
  }

  async createUserMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "user" });
  }

  async createProjectMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "project" });
  }

  async createFeedbackMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "feedback" });
  }

  async planDreamClusters(input: LlmDreamClusterPlanInput): Promise<LlmDreamClusterPlanOutput> {
    if (input.headers.length < 2) {
      return {
        summary: `Not enough ${input.kind} files to form Dream clusters.`,
        clusters: [],
      };
    }
    const allowedRelativePaths = new Set(input.headers.map((header) => header.relativePath));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterPlanPayload>({
      systemPrompt: buildDreamClusterPlanSystemPrompt(input.kind),
      userPrompt: buildDreamClusterPlanPrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster plan" : "Dream feedback cluster plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterPlanPayload,
    });
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream ${input.kind} cluster plan completed.`,
      clusters: Array.isArray(parsed.clusters)
        ? parsed.clusters
            .map((cluster) => normalizeDreamCluster(cluster, allowedRelativePaths))
            .filter((cluster): cluster is LlmDreamCluster => Boolean(cluster))
        : [],
    };
  }

  async refineDreamCluster(input: LlmDreamClusterRefineInput): Promise<LlmDreamClusterRefineOutput> {
    if (input.records.length === 0) {
      return {
        summary: `No ${input.kind} files were supplied for Dream refine.`,
        file: null,
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterRefinePayload>({
      systemPrompt: buildDreamClusterRefineSystemPrompt(input.kind),
      userPrompt: buildDreamClusterRefinePrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster refine" : "Dream feedback cluster refine",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterRefinePayload,
    });
    const name = typeof parsed.name === "string" ? truncate(normalizeWhitespace(parsed.name), 120) : "";
    const description = typeof parsed.description === "string" ? truncate(normalizeWhitespace(parsed.description), 320) : "";
    const markdown = typeof parsed.markdown === "string" ? parsed.markdown.trim() : "";
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream ${input.kind} cluster refine completed.`,
      file: name && description && markdown
        ? { name, description, markdown }
        : null,
    };
  }

  async planGeneralProjectMetaMerges(
    input: LlmGeneralProjectMetaMergeInput,
  ): Promise<LlmGeneralProjectMetaMergeOutput> {
    if (input.projectMetas.length < 2) {
      return {
        summary: "Fewer than two General project metadata records were available for merge planning.",
        mergeGroups: [],
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawGeneralProjectMetaMergePlanPayload>({
      systemPrompt: GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT,
      userPrompt: buildGeneralProjectMetaMergePrompt(input),
      requestLabel: "General project meta merge plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawGeneralProjectMetaMergePlanPayload,
    });
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : "General project meta merge planning completed.",
      mergeGroups: Array.isArray(parsed.merge_groups)
        ? parsed.merge_groups
            .map((group) => normalizeGeneralProjectMetaMergeGroup(group))
            .filter((group): group is LlmGeneralProjectMetaMergeGroup => Boolean(group))
        : [],
    };
  }

  async reviewDreamProjectMeta(input: LlmDreamProjectMetaReviewInput): Promise<LlmDreamProjectMetaReviewOutput> {
    const fallback = {
      projectName: input.currentMeta.projectName,
      description: input.currentMeta.description,
      status: input.currentMeta.status,
    };
    const parsed = await this.callStructuredJsonWithDebug<RawProjectMetaReviewPayload>({
      systemPrompt: DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT,
      userPrompt: buildDreamProjectMetaReviewPrompt(input),
      requestLabel: "Dream project meta review",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawProjectMetaReviewPayload,
    });
    return normalizeDreamProjectMetaReview(parsed, fallback);
  }

  async planDreamFileMemory(input: LlmDreamFileGlobalPlanInput): Promise<LlmDreamFileGlobalPlanOutput> {
    if (input.records.length === 0) {
      return {
        summary: "No project memory files were available for Dream planning.",
        duplicateTopicCount: 0,
        conflictTopicCount: 0,
        projects: [],
        deletedProjectIds: [],
        deletedEntryIds: [],
      };
    }

    const allowedEntryIds = new Set(input.records.map((record) => record.entryId));
    const allowedProjectIds = new Set(input.currentProjects.map((project) => project.projectId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileGlobalPlanPayload>({
      systemPrompt: DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT,
      userPrompt: buildDreamFileGlobalPlanPrompt(input),
      requestLabel: "Dream file global plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileGlobalPlanPayload,
    });
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .map((item, index) => normalizeDreamFileGlobalPlanProject(item, allowedEntryIds, allowedProjectIds, index))
          .filter((item): item is LlmDreamFileGlobalPlanProject => Boolean(item))
      : [];
    const deletedProjectIds = Array.from(new Set(
      normalizeStringArray(parsed.deleted_project_ids, 200)
        .map((item) => normalizeWhitespace(item))
        .filter((item) => allowedProjectIds.has(item)),
    ));
    const deletedEntryIds = normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400);
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : "Dream file global plan completed.",
      duplicateTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.duplicate_topic_count === "number" ? parsed.duplicate_topic_count : 0),
      ),
      conflictTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.conflict_topic_count === "number" ? parsed.conflict_topic_count : 0),
      ),
      projects,
      deletedProjectIds,
      deletedEntryIds,
    };
  }

  async rewriteDreamFileProject(input: LlmDreamFileProjectRewriteInput): Promise<LlmDreamFileProjectRewriteOutput> {
    if (input.records.length === 0) {
      throw new Error("No memory files were supplied for Dream project rewrite.");
    }
    const allowedEntryIds = new Set(input.records.map((record) => record.entryId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileProjectRewritePayload>({
      systemPrompt: DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT,
      userPrompt: buildDreamFileProjectRewritePrompt(input),
      requestLabel: "Dream file project rewrite",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileProjectRewritePayload,
    });
    const files = Array.isArray(parsed.files)
      ? parsed.files
          .map((item) => normalizeDreamFileProjectRewriteFile(item, allowedEntryIds))
          .filter((item): item is LlmDreamFileProjectRewriteOutputFile => Boolean(item))
      : [];
    const fallbackMeta = {
      projectName: input.project.projectName,
      description: input.project.description,
      status: input.project.status,
    };
    return {
      summary: typeof parsed.summary === "string"
        ? truncate(normalizeWhitespace(parsed.summary), 320)
        : `Dream rewrite completed for ${input.project.projectName}.`,
      projectMeta: normalizeDreamFileProjectMetaPayload(parsed.project_meta, fallbackMeta),
      files,
      deletedEntryIds: normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400),
    };
  }

  async decideFileMemoryRoute(input: {
    query: string;
    recentMessages?: MemoryMessage[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryRoute> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ route?: unknown }>({
        systemPrompt: [
          "You decide whether the current query should trigger long-term memory recall.",
          "Return JSON only with a single field route.",
          "Valid route values: none, user, project, mix.",
          "Use none unless the query clearly needs long-term memory.",
          "Use user only when the query is asking about stable personal identity/background facts about who the user is, such as name, profession, long-term role context, life background, or durable relationships.",
          "Do not use user for reply preferences, language choices, formatting rules, style guidance, file/tool boundaries, or delivery rules; those belong to project.",
          "Use project when the query only needs current project memory, including project facts, collaboration rules, delivery style, file boundaries, or project status.",
          "Use mix only when the query genuinely needs both current project memory and the user's stable identity/background at the same time.",
          "Do not use mix just because both could be helpful; choose mix only when both are actually necessary to answer well.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          recent_messages: (input.recentMessages ?? []).slice(-4).map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 220),
          })),
        }, null, 2),
        requestLabel: "File memory gate",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { route?: unknown },
      });
      return normalizeMemoryRoute(parsed.route) || "none";
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory gate fallback: ${String(error)}`);
      return "none";
    }
  }

  async selectRecallProject(input: {
    query: string;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    allowEmpty?: boolean;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) return {};
    const fallbackProject = chooseBestRecallProjectFallback(input.shortlist);
    const allowEmpty = Boolean(input.allowEmpty);
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_project_id?: unknown; reason?: unknown }>({
        systemPrompt: [
          allowEmpty
            ? "You choose the most relevant existing formal project for long-term memory recall only when one clearly matches the current query."
            : "You choose the single most relevant formal project for long-term memory recall.",
          "Return JSON only with selected_project_id and reason.",
          allowEmpty
            ? "Select at most one project from the provided shortlist."
            : "You must select exactly one project from the provided shortlist.",
          "Use the current query first, then recent user messages only for continuation/disambiguation.",
          "Do not infer a project from assistant wording.",
          "Similar project names are distinct by default; shared domain, shared workflow, or shared feedback do not make them the same project.",
          "If the query explicitly names one shortlist project, prefer that exact project instead of broadening to a nearby or umbrella project.",
          allowEmpty
            ? "If the current query introduces or switches to a new project that is not represented in the shortlist, return an empty selected_project_id."
            : "If the current query introduces or switches to a new project, still choose the best shortlist project.",
          allowEmpty
            ? "If no shortlist project is clearly relevant, return an empty selected_project_id."
            : "If multiple shortlist projects remain plausible, still choose the best one.",
          allowEmpty
            ? "If multiple shortlist projects are plausible but evidence is not decisive, return an empty selected_project_id."
            : "When multiple shortlist projects are plausible, never return empty; choose the best match.",
          "When relevance is comparable, prefer general_local over workspace_external.",
          allowEmpty
            ? "Use empty selected_project_id to skip project-scoped recall for a new or unrelated project; do not force unrelated memory into an existing project."
            : "Never return an empty selected_project_id when the shortlist is non-empty.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          shortlist: input.shortlist.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            status: project.status,
            source_type: project.sourceType ?? "unknown",
            updated_at: project.updatedAt,
            shortlist_score: project.score,
            shortlist_exact: project.exact,
            shortlist_source: project.source,
            matched_text: truncateForPrompt(project.matchedText, 180),
          })),
        }, null, 2),
        requestLabel: "File memory project selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { selected_project_id?: unknown; reason?: unknown },
      });
      const selectedProjectId = typeof parsed.selected_project_id === "string"
        ? parsed.selected_project_id.trim()
        : "";
      const matched = input.shortlist.find((project) => project.projectId === selectedProjectId);
      if (matched) {
        return {
          projectId: matched.projectId,
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : {}),
        };
      }
      if (allowEmpty) {
        return {
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : { reason: selectedProjectId ? "Model returned a project id outside the shortlist." : "Model returned no matching project." }),
        };
      }
      return {
        projectId: fallbackProject.projectId,
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: truncateForPrompt(parsed.reason, 220) }
          : { reason: `Fallback selected ${fallbackProject.projectName}; model returned no valid project id.` }),
      };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project selection fallback: ${String(error)}`);
      if (allowEmpty) {
        return {
          reason: "Project selection failed; no existing project was forced.",
        };
      }
      return {
        projectId: fallbackProject.projectId,
        reason: `Fallback selected ${fallbackProject.projectName}; project selection failed.`,
      };
    }
  }

  async selectIndexProject(input: {
    candidate: MemoryCandidate;
    candidatePreview: string;
    focusTurn: MemoryMessage;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ decision: "attach_existing" | "create_new"; projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) {
      return {
        decision: "create_new",
        reason: "No existing General projects are available for index assignment.",
      };
    }
    try {
      const parsed = await this.callStructuredJsonWithDebug<{
        decision?: unknown;
        selected_project_id?: unknown;
        reason?: unknown;
      }>({
        systemPrompt: [
          "You assign a newly generated long-term memory item to a General Chat project.",
          "This is index-time memory assignment, not recall.",
          "Return JSON only with decision, selected_project_id, and reason.",
          "decision must be one of: attach_existing, create_new.",
          "The primary evidence is candidate_memory_preview: the memory item that will be written.",
          "Use the focus user turn and recent user messages only as supporting context for disambiguation.",
          "Choose attach_existing only when the candidate clearly belongs to exactly one existing General project.",
          "Choose create_new when the candidate is a new project, evidence is insufficient, multiple projects remain plausible, or the match is only a broad domain similarity.",
          "Do not attach just because projects share a category such as SaaS, copywriting, Xiaohongshu, marketing, planning, or content creation.",
          "All shortlist projects are General-local assignment targets; never infer or write to an external workspace.",
          "If decision is attach_existing, selected_project_id must be one id from the shortlist.",
          "If decision is create_new, selected_project_id must be an empty string.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          candidate: {
            type: input.candidate.type,
            name: truncateForPrompt(input.candidate.name, 120),
            description: truncateForPrompt(input.candidate.description, 220),
            rule: input.candidate.rule ? truncateForPrompt(input.candidate.rule, 220) : null,
            summary: input.candidate.summary ? truncateForPrompt(input.candidate.summary, 220) : null,
            why: input.candidate.why ? truncateForPrompt(input.candidate.why, 220) : null,
            how_to_apply: input.candidate.howToApply ? truncateForPrompt(input.candidate.howToApply, 220) : null,
            stage: input.candidate.stage ? truncateForPrompt(input.candidate.stage, 220) : null,
            decisions: (input.candidate.decisions ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            constraints: (input.candidate.constraints ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            next_steps: (input.candidate.nextSteps ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            blockers: (input.candidate.blockers ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            timeline: (input.candidate.timeline ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
            notes: (input.candidate.notes ?? []).slice(0, 10).map((item) => truncateForPrompt(item, 160)),
          },
          candidate_memory_preview: truncateForPrompt(input.candidatePreview, 1600),
          focus_user_turn: truncateForPrompt(input.focusTurn.content, 360),
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          shortlist: input.shortlist.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            status: project.status,
            updated_at: project.updatedAt,
            shortlist_score: project.score,
            shortlist_exact: project.exact,
            shortlist_source: project.source,
            matched_text: truncateForPrompt(project.matchedText, 180),
          })),
        }, null, 2),
        requestLabel: "File memory project assignment",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as {
          decision?: unknown;
          selected_project_id?: unknown;
          reason?: unknown;
        },
      });
      const decision = parsed.decision === "attach_existing" ? "attach_existing" : "create_new";
      const selectedProjectId = typeof parsed.selected_project_id === "string"
        ? parsed.selected_project_id.trim()
        : "";
      const matched = input.shortlist.find((project) => project.projectId === selectedProjectId);
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? truncateForPrompt(parsed.reason, 260)
        : "";
      if (decision === "attach_existing" && matched) {
        return {
          decision: "attach_existing",
          projectId: matched.projectId,
          ...(reason ? { reason } : {}),
        };
      }
      return {
        decision: "create_new",
        ...(reason
          ? { reason }
          : { reason: decision === "attach_existing" ? "Model selected an invalid project id." : "Model chose to create a new General project." }),
      };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project assignment fallback: ${String(error)}`);
      return {
        decision: "create_new",
        reason: "Project assignment failed; creating a new General project is safer than forcing an existing project.",
      };
    }
  }

  async selectFileManifestEntries(input: {
    query: string;
    route: MemoryRoute;
    recentUserMessages?: MemoryMessage[];
    projectMeta?: ProjectMetaRecord;
    manifest: RecallHeaderEntry[];
    limit?: number;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<string[]> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_ids?: unknown }>({
        systemPrompt: [
          "You select a small number of memory files from a compact manifest.",
          "Return JSON only with selected_ids.",
          "Select at most 5 ids and prefer recent items that are directly useful for the query.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          query: input.query,
          route: input.route,
          recent_user_messages: (input.recentUserMessages ?? []).slice(-4).map((message) => truncateForPrompt(message.content, 220)),
          project: input.projectMeta
            ? {
                project_id: input.projectMeta.projectId,
                project_name: input.projectMeta.projectName,
                description: truncateForPrompt(input.projectMeta.description, 180),
                status: input.projectMeta.status,
              }
            : null,
          manifest: input.manifest.slice(0, 200).map((entry) => ({
            id: entry.relativePath,
            type: entry.type,
            scope: entry.scope,
            project_id: entry.projectId ?? null,
            updated_at: entry.updatedAt,
            description: truncateForPrompt(entry.description, 200),
          })),
          limit: Math.max(1, Math.min(5, input.limit ?? 5)),
        }, null, 2),
        requestLabel: "File memory selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { selected_ids?: unknown },
      });
      const selected = normalizeStringArray(parsed.selected_ids, Math.max(1, Math.min(5, input.limit ?? 5)));
      return selected;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory selection fallback: ${String(error)}`);
      return [];
    }
  }

  async extractFileMemoryCandidates(input: {
    timestamp: string;
    sessionKey?: string;
    messages: MemoryMessage[];
    batchContextMessages?: MemoryMessage[];
    knownProjects?: ProjectIdentityHint[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    decisionTrace?: (debug: FileMemoryExtractionDebug) => void;
  }): Promise<MemoryCandidate[]> {
    const focusMessages = input.messages.filter((message) => message.role === "user");
    if (focusMessages.length === 0) return [];
    const batchContextMessages = input.batchContextMessages?.length
      ? input.batchContextMessages
      : input.messages;
    const focusText = focusMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    const explicitProjectName = extractProjectNameHint(focusText);
    const explicitProjectDescriptor = extractProjectDescriptorHint(focusText);
    const explicitProjectStage = extractProjectStageHint(focusText);
    const explicitTimeline = extractTimelineHints(focusText);
    const explicitGoal = extractSingleHint(focusText, /目标(?:是|为|:|：)?\s*([^。；;\n]+)/i);
    const explicitBlocker = extractSingleHint(focusText, /当前卡点(?:是|为)?([^。；;\n]+)/i);
    const genericProjectAnchor = hasGenericProjectAnchor(focusText);
    const uniqueBatchProjectName = extractUniqueBatchProjectName(batchContextMessages);
    const selectedKnownProject = selectKnownProjectHint(focusText, input.knownProjects ?? []);
    const contextProjectName = selectedKnownProject?.projectName ?? uniqueBatchProjectName;
    const projectFollowUpSignal = looksLikeProjectFollowUpText(focusText);
    const projectRiskSignal = looksLikeProjectRiskText(focusText);
    const projectScopeSignal = looksLikeProjectScopeText(focusText);
    const projectDefinitionSignal = Boolean(
      explicitProjectName
      || explicitProjectDescriptor
      || explicitProjectStage
      || explicitGoal
      || explicitBlocker
      || explicitTimeline.length > 0
      || projectRiskSignal
      || projectScopeSignal
      || looksLikeConcreteProjectMemoryText(focusText)
    );
    const feedbackInstructionSignal = looksLikeCollaborationRuleText(focusText);

    try {
      const parsed = await this.callStructuredJsonWithDebug<{ items?: unknown[] }>({
        systemPrompt: [
          "You extract long-term memory candidates for one focus conversation turn using recent session context since the last indexing cursor.",
          "Return JSON only with an items array.",
          "Allowed item.type values: user, feedback, project.",
          "Discard anything that is too transient or not useful across future sessions.",
          "Use the batch context to interpret ambiguous references in the focus turn, but only emit memories justified by the focus user turn itself.",
          "known_projects contains the durable identity of the current workspace project.",
          "The assistant replies in the batch context are supporting context only. Never create a memory candidate from assistant wording alone.",
          "For user items only keep stable personal identity/background facts or durable relationships. Never place project state, collaboration rules, reply preferences, language choices, style rules, or file boundaries inside user memory.",
          "If a first-person statement is really about how the assistant should collaborate, write, format, reply, or operate on files, it is feedback, not user.",
          "Global-seeming reply preferences and personal file boundaries still belong to feedback in this runtime. Examples: '默认使用中文输出', '如果有结论先给结论再给细节', '不要改动我的 .gitignore 文件', '我更关心项目进度、风险和上线阻塞点'.",
          "If the focus turn tells the assistant how to collaborate, deliver, report, format, or structure outputs, that is feedback, not project.",
          "If the focus turn says how outputs should be delivered, such as title count, body order, cover copy, progress update order, or reply structure, you must classify it as feedback rather than project.",
          "For feedback items always provide rule, why, and how_to_apply.",
          "For feedback items: why means why the user gave this feedback, usually a past incident, strong preference, or explicit dissatisfaction. Do not invent a reason if the transcript does not contain one.",
          "For feedback items: how_to_apply means when or where this guidance should be applied, such as during progress updates, reviews, or project replies. Do not restate the rule verbatim if the application context is unclear.",
          "If the transcript gives a rule but not enough evidence for why or how_to_apply, return an empty string for those fields.",
          "Feedback belongs to the current project workflow; if project_id is unclear you may omit it because the runtime already knows the current project.",
          "If the batch context contains the current project identity, you may attach project_id to the feedback item; leaving it empty is also acceptable in current-project mode.",
          "If the focus user turn explicitly asks the assistant to remember something long-term, such as '请记住', '帮我记住', or 'remember this', treat that as a stronger signal that durable memory should be extracted.",
          "That stronger signal is still based on the raw user text itself. Do not rely on any hidden remember flag or external rule; decide only from the visible transcript content.",
          "For project items always prefer name plus description. project_id is optional and only refers to the current project identity when supplied.",
          "If you only know the project's human-readable title, put it in name and leave project_id empty.",
          "Do not put a human-readable project title only inside project_id.",
          "For project items provide stage, decisions, constraints, next_steps, blockers, and absolute-date timeline entries when dates are mentioned. You may omit project_id when the project identity is still unclear.",
          "A project-definition turn is about project name, what the project is, its stage, goals, blockers, milestones, or timeline. A delivery rule alone is never a project item.",
          "Treat explicit project-definition statements as project memory even without a remember command. Examples: '这个项目先叫 Boreal', '它是一个本地知识库整理工具', '目前还在设计阶段'.",
          "Natural follow-up turns can still be project memory even when they do not repeat the project name.",
          "If the batch context already contains the current project identity, and the focus turn says things like '这个项目接下来最该补的是...', '这个方向还差...', '先把镜头顺序模板化', or mentions stage, priorities, blockers, constraints, target audience, or content angle, emit a project item for that current project.",
          "If known_projects contains the current project identity and the focus turn states current scope, retained tools, risks, blockers, or project follow-up facts without repeating the project name, attach the memory to that current project instead of inventing a new top-level project.",
          "Do not require the focus turn to repeat the project name when the batch context already makes the project identity unique.",
          "Treat explicit collaboration instructions as feedback. Example: '在这个项目里，每次给我交付时都先给3个标题，再给正文，再给封面文案。'",
          "When a transcript names a project, describes what the project is, or states its current stage, emit a project item unless the content is obviously too transient.",
          "Do not create placeholder project names like overview, project, or memory-item.",
          "Generic anchors such as '这个项目' only become project memory when the batch context provides a unique project identity.",
          "If no durable memory should be saved, return {\"items\":[]}.",
        ].join("\n"),
        userPrompt: JSON.stringify({
          timestamp: input.timestamp,
          known_projects: (input.knownProjects ?? []).slice(0, 20).map((project) => ({
            identity_key: project.identityKey,
            project_id: project.projectId ?? "",
            project_name: project.projectName,
            description: truncateForPrompt(project.description, 180),
            scope: project.scope,
            updated_at: project.updatedAt,
          })),
          batch_context: batchContextMessages.map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 260),
          })),
          focus_user_turn: focusMessages.map((message) => ({
            role: message.role,
            content: truncateForPrompt(message.content, 320),
          })),
        }, null, 2),
        requestLabel: "File memory extraction",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: (raw) => JSON.parse(extractFirstJsonObject(raw)) as { items?: unknown[] },
      });
      if (!Array.isArray(parsed.items)) {
        input.decisionTrace?.({
          parsedItems: [],
          normalizedCandidates: [],
          discarded: [{
            reason: "invalid_schema",
            summary: "Model output did not contain an items array.",
          }],
          finalCandidates: [],
        });
        return [];
      }
      const discarded: FileMemoryExtractionDiscardedCandidate[] = [];
      const parsedItems = parsed.items.filter(isRecord);
      const items = parsedItems
        .map((item): MemoryCandidate | null => {
          const type = item.type === "feedback" || item.type === "project" ? item.type : item.type === "user" ? "user" : null;
          if (!type) {
            discarded.push({
              reason: "invalid_schema",
              summary: typeof item.type === "string" ? `Unsupported type: ${item.type}` : "Missing candidate type.",
            });
            return null;
          }
          const rawName = typeof item.name === "string" ? truncateForPrompt(item.name, 80) : "";
          const rawProjectName = typeof item.project_name === "string" ? truncateForPrompt(item.project_name, 80) : "";
          const rawProjectId = typeof item.project_id === "string" ? truncateForPrompt(item.project_id, 80) : "";
          const rawContent = typeof item.content === "string"
            ? truncateForPrompt(normalizeWhitespace(item.content), 280)
            : "";
          const feedbackRule = typeof item.rule === "string"
            ? truncateForPrompt(normalizeWhitespace(item.rule), 220)
            : "";
          const rawDescription = typeof item.description === "string"
            ? truncateForPrompt(item.description, 180)
            : "";
          const rawSummary = typeof item.summary === "string"
            ? truncateForPrompt(item.summary, 180)
            : "";
          const rawStage = typeof item.stage === "string"
            ? truncateForPrompt(item.stage, 220)
            : "";
          const rawGoal = typeof item.goal === "string"
            ? truncateForPrompt(normalizeWhitespace(item.goal), 180)
            : "";
          const rawDecisions = normalizeStringArray(item.decisions, 10);
          const rawConstraints = normalizeStringArray(item.constraints, 10);
          const rawNextSteps = normalizeStringArray(item.next_steps, 10);
          const rawBlockers = normalizeStringArray(item.blockers, 10);
          const timeline = normalizeStringArray(item.timeline, 10);
          const rawNotes = normalizeStringArray(item.notes, 10);
          const structuredProjectSummary = truncateForPrompt(
            rawDecisions[0]
            || rawConstraints[0]
            || rawNextSteps[0]
            || rawBlockers[0]
            || timeline[0]
            || rawNotes[0]
            || "",
            180,
          );
          if (type === "feedback" && !feedbackRule) {
            discarded.push({
              reason: "invalid_schema",
              candidateType: type,
              ...((rawName || typeof item.name === "string") ? { candidateName: rawName || String(item.name).trim() } : {}),
              summary: "Feedback candidate missing a non-empty rule.",
            });
            return null;
          }
          const candidateType = type;
          const shouldPinToKnownProject = Boolean(selectedKnownProject && !explicitProjectName);
          const projectNameFallback = candidateType === "project"
            ? truncateForPrompt(
              explicitProjectName
              || (shouldPinToKnownProject ? selectedKnownProject?.projectName ?? "" : "")
              || rawName
              || rawProjectName
              || (isLikelyHumanReadableProjectIdentifier(rawProjectId) ? rawProjectId : "")
              || extractProjectNameFromContent(rawContent)
              || contextProjectName,
              80,
            )
            : "";
          const description = rawDescription
            || (typeof item.profile === "string"
              ? truncateForPrompt(item.profile, 180)
              : rawContent
                ? sanitizeProjectDescriptionText(rawContent, projectNameFallback)
              : rawSummary
                ? rawSummary
                : feedbackRule
                  ? truncateForPrompt(feedbackRule, 180)
                  : rawGoal
                    ? rawGoal
                    : explicitProjectDescriptor
                      ? explicitProjectDescriptor
                    : explicitGoal
                        ? explicitGoal
                        : rawStage
                          ? truncateForPrompt(rawStage, 180)
                          : explicitProjectStage
                            ? truncateForPrompt(explicitProjectStage, 180)
                            : structuredProjectSummary);
          const normalizedProjectDescription = candidateType === "project"
            && structuredProjectSummary
            && (!description || description === explicitProjectDescriptor || description === explicitGoal)
            ? structuredProjectSummary
            : description;
          const name = candidateType === "user"
            ? "user-profile"
            : candidateType === "feedback"
              ? truncateForPrompt(rawName || deriveFeedbackCandidateName(feedbackRule), 80)
              : projectNameFallback;
          const preferences = candidateType === "user"
            ? []
            : normalizeStringArray(item.preferences, 10);
          const constraints = candidateType === "user"
            ? []
            : rawConstraints;
          const decisions = candidateType === "project" && projectScopeSignal
            ? uniqueStrings([...rawDecisions, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
            : rawDecisions;
          const nextSteps = rawNextSteps;
          const blockers = candidateType === "project" && projectRiskSignal
            ? uniqueStrings([...rawBlockers, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
            : rawBlockers;
          const notes = candidateType === "project" && !projectScopeSignal && !projectRiskSignal
            ? rawNotes
            : uniqueStrings(rawNotes, 10);
          const relationships = normalizeStringArray(item.relationships, 10);
          const hasUserPayload = Boolean(
            normalizedProjectDescription
            || rawContent
            || (typeof item.profile === "string" && normalizeWhitespace(item.profile))
            || (typeof item.summary === "string" && normalizeWhitespace(item.summary))
            || relationships.length > 0,
          );
          if (candidateType === "project" && (!name || !description)) {
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              ...((name || rawName) ? { candidateName: name || rawName } : {}),
              summary: "Candidate missing a stable name or description.",
            });
            return null;
          }
          if (candidateType === "user" && (!name || !hasUserPayload)) {
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              candidateName: "user-profile",
              summary: "User candidate did not contain any durable profile content.",
            });
            return null;
          }
          if (candidateType === "project" && isGenericProjectCandidateName(name)) {
            discarded.push({
              reason: "generic_project_name",
              candidateType,
              candidateName: name,
              summary: description,
            });
            return null;
          }
          return {
            type: candidateType,
            scope: candidateType === "user" ? "global" : "project",
            ...(() => {
              if (candidateType !== "project" && candidateType !== "feedback") return {};
              if (typeof item.project_id === "string" && isStableFormalProjectId(item.project_id)) {
                return { projectId: item.project_id.trim() };
              }
              if (selectedKnownProject?.projectId && isStableFormalProjectId(selectedKnownProject.projectId)) {
                return { projectId: selectedKnownProject.projectId };
              }
              return {};
            })(),
            name,
            description: normalizedProjectDescription,
            ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
            capturedAt: input.timestamp,
            ...(typeof item.profile === "string"
              ? { profile: truncateForPrompt(item.profile, 280) }
              : rawContent
                ? { profile: rawContent }
                : {}),
            ...(typeof item.summary === "string" ? { summary: truncateForPrompt(item.summary, 280) } : {}),
            ...(preferences.length > 0 ? { preferences } : {}),
            ...(constraints.length > 0 ? { constraints } : {}),
            ...(relationships.length > 0 ? { relationships } : {}),
            ...(candidateType === "feedback" && feedbackRule ? { rule: feedbackRule } : {}),
            ...(typeof item.why === "string" && sanitizeFeedbackSectionText(item.why)
              && candidateType === "feedback"
              ? { why: truncateForPrompt(sanitizeFeedbackSectionText(item.why), 280) }
              : {}),
            ...(typeof item.how_to_apply === "string" && sanitizeFeedbackSectionText(item.how_to_apply)
              && candidateType === "feedback"
              ? { howToApply: truncateForPrompt(sanitizeFeedbackSectionText(item.how_to_apply), 280) }
              : {}),
            ...(candidateType === "project" && rawStage ? { stage: rawStage } : {}),
            decisions,
            nextSteps,
            blockers,
            timeline,
            notes,
          };
        })
        .filter((item): item is MemoryCandidate => Boolean(item));
      const filtered = items.filter((item) => {
        const hasStructuredProjectEvidence = item.type === "project"
          && Boolean(
            item.stage
            || item.constraints?.length
            || item.decisions?.length
            || item.nextSteps?.length
            || item.blockers?.length
            || item.timeline?.length
            || item.notes?.length,
          );
        const text = [
          item.description,
          item.summary ?? "",
          item.rule ?? "",
          item.stage ?? "",
          ...(item.preferences ?? []),
          ...(item.notes ?? []),
          ...(item.nextSteps ?? []),
          ...(item.blockers ?? []),
          ...(item.timeline ?? []),
        ].join(" ");
        if (item.type === "user") {
          return true;
        }
        if (item.type === "project") {
          if (feedbackInstructionSignal && !projectDefinitionSignal) {
            discarded.push({
              reason: "violates_feedback_project_boundary",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (genericProjectAnchor && !projectDefinitionSignal && !contextProjectName) {
            discarded.push({
              reason: "generic_anchor_without_unique_project",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (
            genericProjectAnchor
            && !projectDefinitionSignal
            && contextProjectName
            && !hasStructuredProjectEvidence
            && !projectFollowUpSignal
            && !looksLikeConcreteProjectMemoryText(text)
            && !looksLikeProjectFollowUpText(text)
          ) {
            discarded.push({
              reason: "generic_anchor_without_project_definition",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
        }
        if (item.type === "feedback" && projectDefinitionSignal && !feedbackInstructionSignal) {
          discarded.push({
            reason: "violates_feedback_project_boundary",
            candidateType: item.type,
            candidateName: item.name,
            summary: item.description,
          });
          return false;
        }
        return true;
      });
      const syntheticProjectFallback = filtered.length === 0
        && !feedbackInstructionSignal
        && contextProjectName
        && (
          projectFollowUpSignal
          || projectRiskSignal
          || projectScopeSignal
          || (genericProjectAnchor && looksLikeConcreteProjectMemoryText(focusText))
        )
        ? buildSyntheticProjectFollowUpCandidate({
            focusText,
            timestamp: input.timestamp,
            ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
            uniqueBatchProjectName: contextProjectName,
            explicitProjectName,
            explicitProjectDescriptor,
            explicitProjectStage,
            explicitTimeline,
            explicitGoal,
            explicitBlocker,
          })
        : null;
      const finalCandidates = syntheticProjectFallback ? [syntheticProjectFallback] : filtered;
      input.decisionTrace?.({
        parsedItems,
        normalizedCandidates: items,
        discarded,
        finalCandidates,
      });
      return finalCandidates;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory extraction fallback: ${String(error)}`);
      input.decisionTrace?.({
        parsedItems: [],
        normalizedCandidates: [],
        discarded: [{
          reason: "extract_error",
          summary: error instanceof Error ? error.message : String(error),
        }],
        finalCandidates: [],
      });
      return [];
    }
  }
}
