import type {
  IndexTraceRecord,
  IndexTraceStep,
  IndexTraceStoredResult,
  IndexingSettings,
  L0SessionRecord,
  MemoryCandidate,
  MemoryFileRecord,
  MemoryMessage,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
  ReadableProjectCatalogEntry,
  RetrievalPromptDebug,
  TraceI18nText,
} from "../types.js";
import {
  LlmMemoryExtractor,
  type MemoryClassificationLabel,
} from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
import { traceI18n } from "../trace-i18n.js";
import { buildL0IndexId, hashText, nowIso } from "../utils/id.js";
import { decodeEscapedUnicodeText, decodeEscapedUnicodeValue } from "../utils/text.js";

const LAST_INDEXED_AT_STATE_KEY = "lastIndexedAt" as const;
const GENERAL_INDEX_PROJECT_CANDIDATE_LIMIT = 30;

export interface HeartbeatOptions {
  batchSize?: number;
  source?: string;
  settings: IndexingSettings;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

export interface HeartbeatRunOptions {
  batchSize?: number;
  sessionKeys?: string[];
  reason?: string;
}

export interface HeartbeatStats {
  capturedSessions: number;
  writtenFiles: number;
  writtenUserFiles: number;
  writtenProjectFiles: number;
  writtenFeedbackFiles: number;
  userProfilesUpdated: number;
  failedSessions: number;
}

function sameMessage(left: MemoryMessage | undefined, right: MemoryMessage | undefined): boolean {
  if (!left || !right) return false;
  return left.role === right.role && left.content === right.content;
}

function hasNewContent(previous: MemoryMessage[], incoming: MemoryMessage[]): boolean {
  if (incoming.length === 0) return false;
  if (previous.length === 0) return true;
  if (incoming.length > previous.length) return true;
  for (let index = 0; index < incoming.length; index += 1) {
    if (!sameMessage(previous[index], incoming[index])) return true;
  }
  return false;
}

function emptyStats(): HeartbeatStats {
  return {
    capturedSessions: 0,
    writtenFiles: 0,
    writtenUserFiles: 0,
    writtenProjectFiles: 0,
    writtenFeedbackFiles: 0,
    userProfilesUpdated: 0,
    failedSessions: 0,
  };
}

function tokenizeSearchText(value: string): string[] {
  const stopwords = new Set([
    "项目",
    "当前",
    "这个",
    "那个",
    "现在",
    "一下",
    "关于",
    "里面",
    "这里",
    "那里",
    "怎么",
    "怎样",
    "如何",
    "什么",
    "哪些",
    "进展",
    "情况",
    "默认",
    "应该",
    "需要",
    "general",
  ]);
  const expandCjkToken = (token: string): string[] => {
    if (!/[\p{Script=Han}]/u.test(token)) return [token];
    const pieces = token.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [token];
    const expanded: string[] = [];
    for (const piece of pieces) {
      if (!/[\p{Script=Han}]/u.test(piece)) {
        expanded.push(piece);
        continue;
      }
      if (piece.length <= 8) expanded.push(piece);
      for (const size of [2, 3]) {
        if (piece.length < size) continue;
        for (let index = 0; index <= piece.length - size; index += 1) {
          expanded.push(piece.slice(index, index + size));
        }
      }
    }
    return expanded;
  };
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .flatMap((item) => expandCjkToken(item))
      .filter((item) => item.length >= 2),
  )).filter((item) => !stopwords.has(item));
}

function buildGeneralProjectShortlist(
  catalog: ReadableProjectCatalogEntry[],
  text: string,
): ProjectShortlistCandidate[] {
  const tokens = tokenizeSearchText(text);
  return catalog
    .map((project) => {
      const haystack = `${project.projectName} ${project.description}`.toLowerCase();
      const exact = text.toLowerCase().includes(project.projectName.toLowerCase()) ? 2 : 0;
      const matchedTokens = tokens.filter((token) => haystack.includes(token));
      const score = exact * 10 + matchedTokens.length;
      return {
        projectId: project.logicalProjectId,
        projectName: project.projectName,
        description: project.description,
        status: project.status,
        updatedAt: project.summary.latestMemoryAt || project.updatedAt,
        sourceType: project.sourceType === "workspace_external" ? "workspace_external" : "general_local",
        score,
        exact,
        source: exact > 0 || matchedTokens.length > 0 ? "query" : "recent",
        matchedText: matchedTokens.join(", "),
      } satisfies ProjectShortlistCandidate;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, GENERAL_INDEX_PROJECT_CANDIDATE_LIMIT);
}

function buildCandidateRoutingQuery(candidate: MemoryCandidate, focusTurn: MemoryMessage): string {
  return [
    focusTurn.content,
    candidate.name,
    candidate.description,
    candidate.rule,
    candidate.summary,
    candidate.stage,
    ...(candidate.constraints ?? []),
    ...(candidate.decisions ?? []),
    ...(candidate.blockers ?? []),
  ].filter(Boolean).join("\n");
}

function buildCandidateMemoryPreview(candidate: MemoryCandidate): string {
  const lines: string[] = [
    `# ${candidate.name}`,
    "",
    `type: ${candidate.type}`,
    `description: ${candidate.description}`,
  ];
  if (candidate.type === "feedback") {
    lines.push("", "## Rule", candidate.rule || candidate.description || candidate.summary || candidate.name);
    if (candidate.why) lines.push("", "## Why", candidate.why);
    if (candidate.howToApply) lines.push("", "## How To Apply", candidate.howToApply);
  }
  if (candidate.type === "project") {
    if (candidate.stage) lines.push("", "## Current Stage", candidate.stage);
    const sections: Array<[string, string[] | undefined]> = [
      ["Decisions", candidate.decisions],
      ["Constraints", candidate.constraints],
      ["Next Steps", candidate.nextSteps],
      ["Blockers", candidate.blockers],
      ["Timeline", candidate.timeline],
      ["Notes", candidate.notes],
    ];
    for (const [title, values] of sections) {
      const normalized = (values ?? []).map((item) => item.trim()).filter(Boolean);
      if (normalized.length === 0) continue;
      lines.push("", `## ${title}`, ...normalized.map((item) => `- ${item}`));
    }
    if (candidate.summary) lines.push("", "## Summary", candidate.summary);
  }
  if (candidate.body) lines.push("", "## Body", candidate.body);
  const preview = lines.join("\n").trim();
  return preview.length <= 3000 ? preview : `${preview.slice(0, 3000)}...`;
}

function flattenBatchMessages(
  sessions: L0SessionRecord[],
  seedMessages: MemoryMessage[] = [],
): MemoryMessage[] {
  let previousMessages: MemoryMessage[] = seedMessages;
  for (const session of sessions) {
    previousMessages = mergeSessionMessages(previousMessages, session.messages).mergedMessages;
  }
  return previousMessages;
}

function commonPrefixLength(previous: MemoryMessage[], incoming: MemoryMessage[]): number {
  const limit = Math.min(previous.length, incoming.length);
  let index = 0;
  while (index < limit && sameMessage(previous[index], incoming[index])) {
    index += 1;
  }
  return index;
}

function mergeSessionMessages(
  previousMessages: MemoryMessage[],
  incomingMessages: MemoryMessage[],
): {
  mergedMessages: MemoryMessage[];
  newMessages: MemoryMessage[];
} {
  if (previousMessages.length === 0) {
    return {
      mergedMessages: incomingMessages,
      newMessages: incomingMessages,
    };
  }
  const prefixLength = commonPrefixLength(previousMessages, incomingMessages);
  if (prefixLength > 0) {
    return {
      mergedMessages: incomingMessages,
      newMessages: incomingMessages.slice(prefixLength),
    };
  }
  return {
    mergedMessages: [...previousMessages, ...incomingMessages],
    newMessages: incomingMessages,
  };
}

function deriveFocusTurns(
  previousMessages: MemoryMessage[],
  sessions: L0SessionRecord[],
): Map<string, MemoryMessage[]> {
  const focusTurns = new Map<string, MemoryMessage[]>();
  let cursorMessages = previousMessages;
  for (const session of sessions) {
    const merged = mergeSessionMessages(cursorMessages, session.messages);
    focusTurns.set(
      session.l0IndexId,
      merged.newMessages.filter((message) => message.role === "user"),
    );
    cursorMessages = merged.mergedMessages;
  }
  return focusTurns;
}

function buildIndexTraceId(sessionKey: string, startedAt: string, l0Ids: string[]): string {
  return `index_trace_${hashText(`${sessionKey}:${startedAt}:${l0Ids.join(",")}`)}`;
}

function normalizeTrigger(reason: string | undefined): IndexTraceRecord["trigger"] {
  const normalized = (reason ?? "").trim().toLowerCase();
  if (normalized.includes("scheduled")) return "scheduled";
  return "manual_sync";
}

function previewText(text: string, maxChars = 220): string {
  const normalized = decodeEscapedUnicodeText(text, true).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function inferStorageKind(record: MemoryFileRecord): IndexTraceStoredResult["storageKind"] {
  if (record.type === "general_project_meta") {
    return "general_project_meta";
  }
  if (record.type === "user") {
    return /\/?(UserNotes|UserIdentityNotes)\//.test(record.relativePath) ? "global_user_note" : "global_user";
  }
  return record.type === "feedback" ? "feedback" : "project";
}

function exposeStoredRelativePath(record: MemoryFileRecord): string {
  return record.scope === "global" ? `global/${record.relativePath}` : record.relativePath;
}

function textDetail(
  key: string,
  label: string,
  text: string,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "text",
    text: decodeEscapedUnicodeText(text, true),
  };
}

function noteDetail(
  key: string,
  label: string,
  text: string,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "note",
    text: decodeEscapedUnicodeText(text, true),
  };
}

function listDetail(
  key: string,
  label: string,
  items: string[],
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "list",
    items: items.map((item) => decodeEscapedUnicodeText(item, true)),
  };
}

function kvDetail(
  key: string,
  label: string,
  entries: Array<{ label: string; value: unknown }>,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "kv",
    entries: entries.map((entry) => ({
      label: entry.label,
      value: decodeEscapedUnicodeText(String(entry.value ?? ""), true),
    })),
  };
}

function jsonDetail(
  key: string,
  label: string,
  json: unknown,
  labelI18n?: TraceI18nText,
): NonNullable<IndexTraceStep["details"]>[number] {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "json",
    json: decodeEscapedUnicodeValue(json, true),
  };
}

function createStep(
  trace: IndexTraceRecord,
  kind: IndexTraceStep["kind"],
  title: string,
  status: IndexTraceStep["status"],
  inputSummary: string,
  outputSummary: string,
  options: {
    refs?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    details?: IndexTraceStep["details"];
    promptDebug?: RetrievalPromptDebug;
    titleI18n?: TraceI18nText;
    inputSummaryI18n?: TraceI18nText;
    outputSummaryI18n?: TraceI18nText;
  } = {},
): void {
  trace.steps.push({
    stepId: `${trace.indexTraceId}:step:${trace.steps.length + 1}`,
    kind,
    title,
    status,
    inputSummary,
    outputSummary,
    ...(options.refs ? { refs: options.refs } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.details ? { details: options.details } : {}),
    ...(options.promptDebug ? { promptDebug: options.promptDebug } : {}),
    ...(options.titleI18n ? { titleI18n: options.titleI18n } : {}),
    ...(options.inputSummaryI18n ? { inputSummaryI18n: options.inputSummaryI18n } : {}),
    ...(options.outputSummaryI18n ? { outputSummaryI18n: options.outputSummaryI18n } : {}),
  });
}

function createBatchTrace(
  sessionKey: string,
  sessions: L0SessionRecord[],
  trigger: IndexTraceRecord["trigger"],
  focusUserTurnCount: number,
): IndexTraceRecord {
  const startedAt = nowIso();
  const timestamps = sessions.map((session) => session.timestamp).filter(Boolean).sort();
  return {
    indexTraceId: buildIndexTraceId(sessionKey, startedAt, sessions.map((session) => session.l0IndexId)),
    sessionKey,
    trigger,
    startedAt,
    status: "running",
    isNoOp: false,
    displayStatus: "Running",
    batchSummary: {
      l0Ids: sessions.map((session) => session.l0IndexId),
      segmentCount: sessions.length,
      focusUserTurnCount,
      fromTimestamp: timestamps[0] ?? "",
      toTimestamp: timestamps[timestamps.length - 1] ?? "",
    },
    steps: [],
    storedResults: [],
  };
}

export class HeartbeatIndexer {
  private readonly batchSize: number;
  private readonly source: string;
  private readonly logger: HeartbeatOptions["logger"];
  private settings: IndexingSettings;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly extractor: LlmMemoryExtractor,
    options: HeartbeatOptions,
  ) {
    this.batchSize = options.batchSize ?? 30;
    this.source = options.source ?? "openclaw";
    this.settings = options.settings;
    this.logger = options.logger;
  }

  getSettings(): IndexingSettings {
    return { ...this.settings };
  }

  setSettings(settings: IndexingSettings): void {
    this.settings = { ...settings };
  }

  private async routeGeneralCandidate(input: {
    candidate: MemoryCandidate;
    focusTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
  }): Promise<{
    candidate: MemoryCandidate;
    createdProjectMeta?: ProjectMetaRecord;
    selectedProject?: ReadableProjectCatalogEntry;
    selectionDebug?: RetrievalPromptDebug;
    routingDecision?: "attach_existing" | "create_new";
    routingReason?: string;
  }> {
    const store = this.repository.getFileMemoryStore();
    if (!store.isGeneralMode() || input.candidate.type === "user") {
      return { candidate: input.candidate };
    }

    const routingText = buildCandidateRoutingQuery(input.candidate, input.focusTurn);
    const candidatePreview = buildCandidateMemoryPreview(input.candidate);
    const catalog = this.repository
      .listReadableProjectCatalog()
      .filter((entry) => entry.sourceType !== "workspace_external");
    const shortlist = buildGeneralProjectShortlist(catalog, routingText);
    let selectedProject: ReadableProjectCatalogEntry | undefined;
    let selectionDebug: RetrievalPromptDebug | undefined;
    let routingDecision: "attach_existing" | "create_new" = "create_new";
    let routingReason = shortlist.length > 0
      ? "No existing General project was clearly selected."
      : "No existing General projects are available.";
    if (shortlist.length > 0) {
      const selection = await this.extractor.selectIndexProject({
        candidate: input.candidate,
        candidatePreview,
        focusTurn: input.focusTurn,
        recentUserMessages: input.batchContextMessages.filter((message) => message.role === "user").slice(-4),
        shortlist,
        debugTrace: (debug) => {
          selectionDebug = debug;
        },
      });
      routingDecision = selection.decision;
      routingReason = selection.reason ?? routingReason;
      const selectedProjectId = selection.decision === "attach_existing" ? selection.projectId : undefined;
      selectedProject = selectedProjectId
        ? this.repository.getReadableProject(selectedProjectId)
        : undefined;
      if (selectedProject?.sourceType === "workspace_external") {
        selectedProject = undefined;
        routingDecision = "create_new";
        routingReason = "Selected project was outside General-local index scope.";
      }
    }

    if (selectedProject) {
      return {
        candidate: { ...input.candidate, projectId: selectedProject.projectId },
        selectedProject,
        ...(selectionDebug ? { selectionDebug } : {}),
        routingDecision,
        routingReason,
      };
    }

    const localProject = store.upsertProjectMeta({
      projectName: input.candidate.type === "project" ? input.candidate.name : input.candidate.description || input.candidate.name,
      description: input.candidate.description,
      status: "in_progress",
      sourceKind: "general_local",
    });
    return {
      candidate: { ...input.candidate, projectId: localProject.projectId },
      createdProjectMeta: localProject,
      ...(selectionDebug ? { selectionDebug } : {}),
      routingDecision: "create_new",
      routingReason,
    };
  }

  captureL0Session(input: {
    sessionKey: string;
    timestamp?: string;
    messages: MemoryMessage[];
    source?: string;
  }): L0SessionRecord | undefined {
    const timestamp = input.timestamp ?? nowIso();
    const recent = this.repository.listRecentL0(1)[0];
    if (recent?.sessionKey === input.sessionKey && !hasNewContent(recent.messages, input.messages)) {
      this.logger?.info?.(`[clawxmemory] skip duplicate l0 capture for session=${input.sessionKey}`);
      return undefined;
    }
    const payload = JSON.stringify(input.messages);
    const l0IndexId = buildL0IndexId(input.sessionKey, timestamp, payload);
    const record: L0SessionRecord = {
      l0IndexId,
      sessionKey: input.sessionKey,
      timestamp,
      messages: input.messages,
      source: input.source ?? this.source,
      indexed: false,
      createdAt: nowIso(),
    };
    this.repository.insertL0Session(record);
    return record;
  }

  async runHeartbeat(options: HeartbeatRunOptions = {}): Promise<HeartbeatStats> {
    const stats = emptyStats();
    const sessionKeys = this.repository.listPendingSessionKeys(
      Math.max(1, options.batchSize ?? this.batchSize),
      options.sessionKeys,
    );
    if (sessionKeys.length === 0) return stats;

    const store = this.repository.getFileMemoryStore();
    for (const sessionKey of sessionKeys) {
      const sessions = this.repository.listUnindexedL0BySession(sessionKey);
      if (sessions.length === 0) continue;

      const previousIndexedSession = this.repository.getLatestL0Before(
        sessionKey,
        sessions[0]?.timestamp ?? "",
        sessions[0]?.createdAt ?? "",
      );
      const previousMessages = previousIndexedSession?.messages ?? [];
      const focusTurnsBySession = deriveFocusTurns(previousMessages, sessions);
      const batchContextMessages = flattenBatchMessages(sessions, previousMessages);
      const focusUserTurnCount = Array.from(focusTurnsBySession.values()).reduce((count, turns) => count + turns.length, 0);
      const trace = createBatchTrace(sessionKey, sessions, normalizeTrigger(options.reason), focusUserTurnCount);
      createStep(
        trace,
        "index_start",
        "Index Started",
        "info",
        `trigger=${trace.trigger}`,
        `Preparing batch indexing for ${sessionKey}.`,
        {
          titleI18n: traceI18n("trace.step.index_start", "Index Started"),
          outputSummaryI18n: traceI18n("trace.text.index_start.output.preparing_batch", "Preparing batch indexing for {0}.", sessionKey),
        },
      );
      createStep(
        trace,
        "batch_loaded",
        "Batch Loaded",
        "info",
        `${trace.batchSummary.segmentCount} segments from ${trace.batchSummary.fromTimestamp || "n/a"} to ${trace.batchSummary.toTimestamp || "n/a"}`,
        `${batchContextMessages.length} messages loaded into batch context.`,
        {
          titleI18n: traceI18n("trace.step.batch_loaded", "Batch Loaded"),
          inputSummaryI18n: traceI18n(
            "trace.text.batch_loaded.input",
            "{0} segments from {1} to {2}",
            trace.batchSummary.segmentCount,
            trace.batchSummary.fromTimestamp || "n/a",
            trace.batchSummary.toTimestamp || "n/a",
          ),
          outputSummaryI18n: traceI18n(
            "trace.text.batch_loaded.output",
            "{0} messages loaded into batch context.",
            batchContextMessages.length,
          ),
          metrics: {
            segmentCount: trace.batchSummary.segmentCount,
            focusUserTurnCount: trace.batchSummary.focusUserTurnCount,
          },
          details: [
            kvDetail("batch-summary", "Batch Summary", [
              { label: "sessionKey", value: sessionKey },
              { label: "from", value: trace.batchSummary.fromTimestamp || "" },
              { label: "to", value: trace.batchSummary.toTimestamp || "" },
              { label: "l0Ids", value: trace.batchSummary.l0Ids.join(", ") || "none" },
            ], traceI18n("trace.detail.batch_summary", "Batch Summary")),
            jsonDetail(
              "batch-context",
              "Batch Context",
              batchContextMessages.map((message, index) => ({
                index,
                role: message.role,
                content: message.content,
              })),
              traceI18n("trace.detail.batch_context", "Batch Context"),
            ),
          ],
        },
      );
      createStep(
        trace,
        "focus_turns_selected",
        "Focus Turns Selected",
        trace.batchSummary.focusUserTurnCount > 0 ? "success" : "warning",
        `${trace.batchSummary.focusUserTurnCount} user turns in this batch.`,
        trace.batchSummary.focusUserTurnCount > 0
          ? "User turns will be classified one by one."
          : "No user turns found; this batch will be marked indexed without storing memory.",
        {
          titleI18n: traceI18n("trace.step.focus_turns_selected", "Focus Turns Selected"),
          inputSummaryI18n: traceI18n(
            "trace.text.focus_turns_selected.input",
            "{0} user turns in this batch.",
            trace.batchSummary.focusUserTurnCount,
          ),
          outputSummaryI18n: trace.batchSummary.focusUserTurnCount > 0
            ? traceI18n("trace.text.focus_turns_selected.output.classifying", "User turns will be classified one by one.")
            : traceI18n(
                "trace.text.focus_turns_selected.output.no_user_turns",
                "No user turns found; this batch will be marked indexed without storing memory.",
              ),
          details: [
            kvDetail("focus-turn-selection-summary", "Focus Selection Summary", [
              { label: "userTurns", value: String(trace.batchSummary.focusUserTurnCount) },
              { label: "assistantMessagesInContext", value: String(batchContextMessages.filter((message) => message.role === "assistant").length) },
              { label: "assistantUsedAsContextOnly", value: "yes" },
            ], traceI18n("trace.detail.focus_selection_summary", "Focus Selection Summary")),
            ...sessions
              .flatMap((session) => focusTurnsBySession.get(session.l0IndexId) ?? [])
              .map((message, index) => textDetail(
                `focus-turn-${index + 1}`,
                `Focus Turn ${index + 1}`,
                message.content,
                traceI18n("trace.detail.focus_turn", "Focus Turn {0}", index + 1),
              )),
          ],
        },
      );
      this.repository.saveIndexTrace(trace);

      const processedIds: string[] = [];
      let sessionHadError = false;

      for (const session of sessions) {
        try {
          const focusUserTurns = focusTurnsBySession.get(session.l0IndexId) ?? [];
          if (focusUserTurns.length === 0) {
            processedIds.push(session.l0IndexId);
            stats.capturedSessions += 1;
            continue;
          }

          for (const focusTurn of focusUserTurns) {
            const currentProjectMeta = this.repository.getProjectMeta() ?? store.getProjectMeta() ?? null;
            let classificationPromptDebug: RetrievalPromptDebug | undefined;
            const classification = await this.extractor.classifyMemoryTurn({
              timestamp: session.timestamp,
              sessionKey: session.sessionKey,
              focusUserTurn: focusTurn,
              batchContextMessages,
              currentProjectMeta,
              debugTrace: (debug) => {
                classificationPromptDebug = debug;
              },
            });
            const labels = classification.shouldStore ? classification.labels : [];
            createStep(
              trace,
              "classification",
              "Classification",
              labels.length > 0 ? "success" : "skipped",
              previewText(focusTurn.content, 220),
              labels.length > 0
                ? `classified=${labels.map((label) => label.type).join(", ")}`
                : "classified=none",
              {
                refs: {
                  classification: labels.length > 0 ? labels.map((label) => label.type) : ["none"],
                },
                details: [
                  textDetail(
                    `focus-turn-text-${session.l0IndexId}`,
                    "Focus User Turn",
                    focusTurn.content,
                    traceI18n("trace.detail.focus_user_turn", "Focus User Turn"),
                  ),
                  kvDetail(`classification-result-${session.l0IndexId}`, "Classification Result", [
                    { label: "sessionKey", value: session.sessionKey },
                    { label: "timestamp", value: session.timestamp },
                    { label: "result", value: labels.length > 0 ? labels.map((label) => label.type).join(", ") : "none" },
                  ], traceI18n("trace.detail.classification_result", "Classification Result")),
                  jsonDetail(
                    `classification-labels-${session.l0IndexId}`,
                    "Classification Labels",
                    labels,
                    traceI18n("trace.detail.classifier_candidates", "Classifier Candidates"),
                  ),
                ],
                ...(classificationPromptDebug ? { promptDebug: classificationPromptDebug } : {}),
              },
            );

            const createdCandidates: Array<{ label: MemoryClassificationLabel; candidate: MemoryCandidate | null }> = [];
            for (const label of labels) {
              let createPromptDebug: RetrievalPromptDebug | undefined;
              const candidate = label.type === "user"
                ? await this.extractor.createUserMemoryNote({
                    timestamp: session.timestamp,
                    sessionKey: session.sessionKey,
                    focusUserTurn: focusTurn,
                    batchContextMessages,
                    currentProjectMeta,
                    classification: label,
                    debugTrace: (debug) => {
                      createPromptDebug = debug;
                    },
                  })
                : label.type === "project"
                  ? await this.extractor.createProjectMemoryNote({
                      timestamp: session.timestamp,
                      sessionKey: session.sessionKey,
                      focusUserTurn: focusTurn,
                      batchContextMessages,
                      currentProjectMeta,
                      classification: label,
                      debugTrace: (debug) => {
                        createPromptDebug = debug;
                      },
                    })
                  : await this.extractor.createFeedbackMemoryNote({
                      timestamp: session.timestamp,
                      sessionKey: session.sessionKey,
                      focusUserTurn: focusTurn,
                      batchContextMessages,
                      currentProjectMeta,
                      classification: label,
                      debugTrace: (debug) => {
                        createPromptDebug = debug;
                      },
                    });
              createdCandidates.push({ label, candidate });
              createStep(
                trace,
                label.type === "user" ? "user_create" : label.type === "project" ? "project_create" : "feedback_create",
                `${label.type} Create`,
                candidate ? "success" : "skipped",
                `${label.type} | ${label.reason || "no explicit reason"}`,
                candidate ? `created=${candidate.name}` : `skipped=${label.type}`,
                {
                  refs: {
                    candidateType: label.type,
                  },
                  details: [
                    jsonDetail(
                      `create-${label.type}-${session.l0IndexId}`,
                      `${label.type} Create Result`,
                      {
                        classification: label,
                        candidate: candidate
                          ? {
                              type: candidate.type,
                              name: candidate.name,
                              description: candidate.description,
                              body: candidate.body ?? "",
                            }
                          : null,
                      },
                    ),
                  ],
                  ...(createPromptDebug ? { promptDebug: createPromptDebug } : {}),
                },
              );
            }

            const persistedRecords: MemoryFileRecord[] = [];
            let wroteGlobalUserNote = false;
            for (const { candidate } of createdCandidates) {
              if (!candidate) continue;
              const routed = await this.routeGeneralCandidate({
                candidate,
                focusTurn,
                batchContextMessages,
              });
              if (routed.createdProjectMeta) {
                trace.storedResults.push({
                  candidateType: "general_project_meta",
                  candidateName: routed.createdProjectMeta.projectName,
                  scope: "project",
                  projectId: routed.createdProjectMeta.projectId,
                  sourceKind: routed.selectedProject?.sourceType ?? routed.createdProjectMeta.sourceKind ?? "general_local",
                  relativePath: routed.createdProjectMeta.relativePath,
                  storageKind: "general_project_meta",
                });
                stats.writtenFiles += 1;
                createStep(
                  trace,
                  "project_routed",
                  "Project Routed",
                  "success",
                  previewText(focusTurn.content, 180),
                  `Created new General project ${routed.createdProjectMeta.projectName}.`,
                  {
                    details: [
                      jsonDetail(
                        `project-route-${session.l0IndexId}-${trace.storedResults.length}`,
                        "Project Route",
                        {
                          decision: routed.routingDecision ?? "create_new",
                          reason: routed.routingReason ?? null,
                          candidateType: candidate.type,
                          candidateName: candidate.name,
                          selectedProject: routed.selectedProject?.projectName ?? null,
                          assignedProjectId: routed.createdProjectMeta.projectId,
                          createdProjectMeta: routed.createdProjectMeta.relativePath,
                        },
                      ),
                    ],
                    ...(routed.selectionDebug ? { promptDebug: routed.selectionDebug } : {}),
                  },
                );
              } else if (routed.selectedProject) {
                createStep(
                  trace,
                  "project_routed",
                  "Project Routed",
                  "success",
                  previewText(focusTurn.content, 180),
                  `Assigned to ${routed.selectedProject.projectName}.`,
                  {
                    details: [
                      jsonDetail(
                        `project-route-${session.l0IndexId}-${candidate.name}`,
                        "Project Route",
                        {
                          decision: routed.routingDecision ?? "attach_existing",
                          reason: routed.routingReason ?? null,
                          candidateType: candidate.type,
                          candidateName: candidate.name,
                          selectedProject: routed.selectedProject.projectName,
                          selectedSource: routed.selectedProject.sourceType === "workspace_external" ? "workspace_external" : "general_local",
                          assignedProjectId: routed.selectedProject.projectId,
                        },
                      ),
                    ],
                    ...(routed.selectionDebug ? { promptDebug: routed.selectionDebug } : {}),
                  },
                );
              }
              const targetStore = routed.candidate.type === "user"
                ? this.repository.getGlobalUserStore()
                : store;
              const record = targetStore.upsertCandidate(routed.candidate);
              if (routed.candidate.type === "user") wroteGlobalUserNote = true;
              persistedRecords.push(record);
              trace.storedResults.push({
                candidateType: routed.candidate.type,
                candidateName: routed.candidate.name,
                scope: routed.candidate.scope,
                ...(record.projectId ? { projectId: record.projectId } : {}),
                relativePath: exposeStoredRelativePath(record),
                storageKind: inferStorageKind(record),
              });
              stats.writtenFiles += 1;
              if (routed.candidate.type === "user") stats.writtenUserFiles += 1;
              if (routed.candidate.type === "project") stats.writtenProjectFiles += 1;
              if (routed.candidate.type === "feedback") stats.writtenFeedbackFiles += 1;
            }
            if (wroteGlobalUserNote) {
              this.repository.repairWorkspaceManifest();
            }
            createStep(
              trace,
              "persist",
              "Persist",
              persistedRecords.length > 0 ? "success" : "skipped",
              `${createdCandidates.filter((entry) => entry.candidate).length} candidates ready to persist.`,
              persistedRecords.length > 0
                ? `${persistedRecords.length} memory files written.`
                : "No memory files were written for this turn.",
              {
                details: [jsonDetail(
                  `persisted-files-${session.l0IndexId}`,
                  "Persisted Files",
                  persistedRecords.map((record) => ({
                    type: record.type,
                    name: record.name,
                    projectId: record.projectId ?? null,
                    relativePath: exposeStoredRelativePath(record),
                    storageKind: inferStorageKind(record),
                  })),
                  traceI18n("trace.detail.persisted_files", "Persisted Files"),
                )],
              },
            );
          }
          processedIds.push(session.l0IndexId);
          stats.capturedSessions += 1;
          this.repository.setPipelineState(LAST_INDEXED_AT_STATE_KEY, session.timestamp);
          this.repository.setPipelineState(`lastIndexedCursor:${session.sessionKey}`, session.timestamp);
        } catch (error) {
          stats.failedSessions += 1;
          sessionHadError = true;
          createStep(
            trace,
            "index_finished",
            "Index Error",
            "error",
            session.l0IndexId,
            error instanceof Error ? error.message : String(error),
            {
              titleI18n: traceI18n("trace.text.index_error.title", "Index Error"),
              details: [noteDetail(
                `index-error-${session.l0IndexId}`,
                "Index Error",
                error instanceof Error ? error.message : String(error),
                traceI18n("trace.detail.index_error", "Index Error"),
              )],
            },
          );
          this.logger?.warn?.(`[clawxmemory] heartbeat file-memory extraction failed for ${session.l0IndexId}: ${String(error)}`);
        }
      }

      if (processedIds.length > 0) {
        this.repository.markL0Indexed(processedIds);
      }
      trace.finishedAt = nowIso();
      trace.status = sessionHadError ? "error" : "completed";
      trace.isNoOp = trace.storedResults.length === 0;
      trace.displayStatus = sessionHadError
        ? "Error"
        : trace.isNoOp
          ? "No-op"
          : "Completed";
      createStep(
        trace,
        "index_finished",
        "Index Finished",
        sessionHadError ? "warning" : "success",
        `segments=${trace.batchSummary.segmentCount}`,
        `stored=${trace.storedResults.length}, failed=${sessionHadError ? 1 : 0}`,
        {
          titleI18n: traceI18n("trace.step.index_finished", "Index Finished"),
          metrics: {
            storedResults: trace.storedResults.length,
            failed: sessionHadError ? 1 : 0,
          },
          details: [jsonDetail(
            "stored-results",
            "Stored Results",
            trace.storedResults,
            traceI18n("trace.detail.stored_results", "Stored Results"),
          )],
        },
      );
      this.repository.saveIndexTrace(trace);
    }
    return stats;
  }
}
