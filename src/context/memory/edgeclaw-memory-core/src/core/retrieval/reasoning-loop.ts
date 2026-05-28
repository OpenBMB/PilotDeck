import type {
  IndexingSettings,
  MemoryMessage,
  MemoryRoute,
  MemoryUserSummary,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
  RecallHeaderEntry,
  ReadableProjectCatalogEntry,
  RetrievalPromptDebug,
  TraceI18nText,
  RetrievalTrace,
  RetrievalTraceDetail,
  RetrievalResult,
  RecallMode,
} from "../types.js";
import { LlmMemoryExtractor } from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
import { traceI18n } from "../trace-i18n.js";
import { hashText, nowIso } from "../utils/id.js";
import { decodeEscapedUnicodeText, decodeEscapedUnicodeValue, truncate } from "../utils/text.js";

const RECALL_CACHE_TTL_MS = 30_000;
const MANIFEST_LIMIT = 200;
const DEFAULT_SELECTION_LIMIT = 5;
const RECALL_FILE_MAX_LINES = 200;
const GENERAL_RECALL_PROJECT_CANDIDATE_LIMIT = 30;

export interface RetrievalOptions {
  retrievalMode?: "auto" | "explicit";
  recentMessages?: MemoryMessage[];
  workspaceHint?: string;
}

export interface RetrievalRuntimeOptions {
  getSettings?: () => IndexingSettings;
  isBackgroundBusy?: () => boolean;
}

export interface RetrievalRuntimeStats {
  lastRecallMs: number;
  recallTimeouts: number;
  lastRecallMode: RecallMode;
  lastRecallPath: "auto" | "explicit" | "shadow";
  lastRecallInjected: boolean;
  lastRecallCacheHit: boolean;
}

interface RecallCacheEntry {
  expiresAt: number;
  result: RetrievalResult;
}

function normalizeQueryKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTraceId(prefix: string, seed: string): string {
  return `${prefix}_${hashText(`${seed}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`)}`;
}

function previewText(value: string, max = 220): string {
  return truncate(decodeEscapedUnicodeText(value).trim(), max);
}

function listDetail(
  key: string,
  label: string,
  items: string[],
  labelI18n?: TraceI18nText,
): RetrievalTraceDetail {
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
): RetrievalTraceDetail {
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
): RetrievalTraceDetail {
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "json",
    json: decodeEscapedUnicodeValue(json, true),
  };
}

function hasUserSummary(userSummary: MemoryUserSummary): boolean {
  return Boolean(userSummary.identityBackground.length);
}

function renderUserSummaryBlock(userSummary: MemoryUserSummary): string[] {
  if (!hasUserSummary(userSummary)) return [];
  const updatedAt = userSummary.files[0]?.updatedAt ?? "";
  const relativePath = userSummary.files[0]?.relativePath ?? "global/UserIdentity/user-profile.md";
  const lines = [
    `### [user] ${relativePath}${updatedAt ? ` (${updatedAt})` : ""}`,
    "## 身份背景",
  ];
  if (userSummary.identityBackground.length > 0) {
    lines.push(...userSummary.identityBackground.map((item) => `- ${item}`), "");
  } else {
    lines.push("- 暂无稳定用户画像信息。", "");
  }
  return lines;
}

function renderProjectMetaBlock(projectMeta: ProjectMetaRecord | null): string[] {
  if (!projectMeta) return [];
  const lines = [
    `### [project_meta] ${projectMeta.relativePath} (${projectMeta.updatedAt})`,
    "## Project Name",
    projectMeta.projectName,
    "",
    "## Description",
    projectMeta.description || "No project description yet.",
    "",
    "## Status",
    projectMeta.status,
    "",
  ];
  return lines;
}

function renderSelectedRecordsBlock(
  records: Array<{ relativePath: string; type: string; updatedAt: string; content: string }>,
): string[] {
  const lines: string[] = [];
  for (const record of records) {
    lines.push(`### [${record.type}] ${record.relativePath} (${record.updatedAt})`);
    lines.push(record.content.trim());
    lines.push("");
  }
  return lines;
}

function renderContext(
  route: MemoryRoute,
  userSummary: MemoryUserSummary,
  projectMeta: ProjectMetaRecord | null,
  records: Array<{ relativePath: string; type: string; updatedAt: string; content: string }>,
): string {
  const userSummaryPaths = new Set(userSummary.files.map((file) => file.relativePath));
  const uniqueRecords = records.filter((record) => !userSummaryPaths.has(record.relativePath));
  const lines = ["## ClawXMemory Recall", `route=${route}`, ""];

  if (route === "user") {
    if (!hasUserSummary(userSummary)) return "";
    lines.push(...renderUserSummaryBlock(userSummary));
  } else if (route === "project") {
    if (!projectMeta && uniqueRecords.length === 0) return "";
    lines.push(...renderProjectMetaBlock(projectMeta));
    lines.push(...renderSelectedRecordsBlock(uniqueRecords));
  } else if (route === "mix") {
    if (!hasUserSummary(userSummary) && !projectMeta && uniqueRecords.length === 0) return "";
    lines.push(...renderUserSummaryBlock(userSummary));
    lines.push(...renderProjectMetaBlock(projectMeta));
    lines.push(...renderSelectedRecordsBlock(uniqueRecords));
  } else {
    return "";
  }

  lines.push("Treat these file memories as the authoritative long-term memory for this turn when relevant.");
  return lines.join("\n").trim();
}

function buildEmptyResult(query: string, trace: RetrievalTrace, elapsedMs: number, cacheHit = false): RetrievalResult {
  return {
    query,
    intent: "none",
    context: "",
    trace,
    debug: {
      mode: "none",
      elapsedMs,
      cacheHit,
      path: "explicit",
      route: "none",
      manifestCount: 0,
      selectedFileIds: [],
    },
  };
}

function recentUserMessages(messages: MemoryMessage[] | undefined): MemoryMessage[] {
  return (messages ?? []).filter((message) => message.role === "user").slice(-4);
}

const CJK_TOKEN_STOPWORDS = new Set([
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

function expandCjkSearchToken(token: string): string[] {
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
}

function tokenizeSearchText(value: string): string[] {
  return Array.from(new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .flatMap((item) => expandCjkSearchToken(item))
      .filter((item) => item.length >= 2),
  )).filter((item) => !CJK_TOKEN_STOPWORDS.has(item));
}

function buildProjectShortlist(
  catalog: ReadableProjectCatalogEntry[],
  query: string,
  recentMessages: MemoryMessage[],
): ProjectShortlistCandidate[] {
  const queryTokens = tokenizeSearchText(query);
  const recentText = recentMessages.map((message) => message.content).join(" ");
  const recencyTokens = tokenizeSearchText(recentText);
  const allTokens = Array.from(new Set([...queryTokens, ...recencyTokens]));
  return catalog
    .map((entry) => {
      const haystack = `${entry.projectName} ${entry.description}`.toLowerCase();
      const exact = query.toLowerCase().includes(entry.projectName.toLowerCase()) ? 2 : 0;
      const matchedTokens = allTokens.filter((token) => haystack.includes(token));
      const score = exact * 10 + matchedTokens.length;
      return {
        projectId: entry.logicalProjectId,
        projectName: entry.projectName,
        description: entry.description,
        status: entry.status,
        updatedAt: entry.summary.latestMemoryAt || entry.updatedAt,
        sourceType: entry.sourceType === "workspace_external" ? "workspace_external" : "general_local",
        score,
        exact,
        source: exact > 0 || matchedTokens.length > 0 ? "query" : "recent",
        matchedText: matchedTokens.join(", "),
      } satisfies ProjectShortlistCandidate;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.exact !== left.exact) return right.exact - left.exact;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, GENERAL_RECALL_PROJECT_CANDIDATE_LIMIT);
}

function createTrace(
  query: string,
  mode: "auto" | "explicit",
): RetrievalTrace {
  return {
    traceId: buildTraceId("trace", query),
    query,
    mode,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    steps: [],
  };
}

function pushStep(
  trace: RetrievalTrace,
  kind: RetrievalTrace["steps"][number]["kind"],
  title: string,
  status: RetrievalTrace["steps"][number]["status"],
  inputSummary: string,
  outputSummary: string,
  options: {
    refs?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    details?: RetrievalTrace["steps"][number]["details"];
    promptDebug?: RetrievalPromptDebug;
    titleI18n?: TraceI18nText;
    inputSummaryI18n?: TraceI18nText;
    outputSummaryI18n?: TraceI18nText;
  } = {},
): void {
  trace.steps.push({
    stepId: `${trace.traceId}:step:${trace.steps.length + 1}`,
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

function fallbackSelection(
  route: MemoryRoute,
  manifest: RecallHeaderEntry[],
): string[] {
  if (manifest.length === 0) return [];
  const limit = route === "user" ? 1 : 3;
  return manifest.slice(0, limit).map((entry) => entry.relativePath);
}

export class ReasoningRetriever {
  private readonly recallCache = new Map<string, RecallCacheEntry>();
  private runtimeStats: RetrievalRuntimeStats = {
    lastRecallMs: 0,
    recallTimeouts: 0,
    lastRecallMode: "none",
    lastRecallPath: "explicit",
    lastRecallInjected: false,
    lastRecallCacheHit: false,
  };

  constructor(
    private readonly repository: MemoryRepository,
    private readonly extractor: LlmMemoryExtractor,
    private readonly options: RetrievalRuntimeOptions = {},
  ) {}

  getRuntimeStats(): RetrievalRuntimeStats {
    return { ...this.runtimeStats };
  }

  resetTransientState(): void {
    this.recallCache.clear();
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
    const startedAtMs = Date.now();
    const mode = options.retrievalMode ?? "auto";
    const cacheKey = JSON.stringify({
      mode,
      query: normalizeQueryKey(query),
      recent: recentUserMessages(options.recentMessages).map((message) => message.content),
      snapshot: this.repository.getSnapshotVersion(),
    });
    const cached = this.recallCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.runtimeStats = {
        ...this.runtimeStats,
        lastRecallMs: 0,
        lastRecallMode: cached.result.debug?.mode ?? "none",
        lastRecallPath: cached.result.debug?.path ?? mode,
        lastRecallInjected: Boolean(cached.result.context),
        lastRecallCacheHit: true,
      };
      return {
        ...cached.result,
        debug: {
          ...(cached.result.debug ?? {
            mode: "none" as const,
            elapsedMs: 0,
            path: mode,
          }),
          cacheHit: true,
          elapsedMs: 0,
        },
      };
    }

    const trace = createTrace(query, mode);
    pushStep(
      trace,
      "recall_start",
      "Recall Started",
      "info",
      query,
      `mode=${mode}`,
      {
        titleI18n: traceI18n("trace.step.recall_start", "Recall Started"),
        details: [
          kvDetail("recall-start-inputs", "Recall Inputs", [
            { label: "query", value: query },
            { label: "mode", value: mode },
            { label: "recentUserMessages", value: recentUserMessages(options.recentMessages).length },
            { label: "workspaceHint", value: options.workspaceHint ?? "" },
          ], traceI18n("trace.detail.recall_inputs", "Recall Inputs")),
        ],
      },
    );

    let gateDebug: RetrievalPromptDebug | undefined;
    const route = await this.extractor.decideFileMemoryRoute({
      query,
      recentMessages: options.recentMessages,
      debugTrace: (debug) => {
        gateDebug = debug;
      },
    });
    pushStep(
      trace,
      "memory_gate",
      "Memory Gate",
      route === "none" ? "warning" : "success",
      query,
      `route=${route}`,
      {
        titleI18n: traceI18n("trace.step.memory_gate", "Memory Gate"),
        details: [
          kvDetail("gate-route", "Route", [
            { label: "route", value: route },
            { label: "recentUserMessages", value: recentUserMessages(options.recentMessages).length },
            { label: "workspaceHint", value: options.workspaceHint ?? "" },
          ], traceI18n("trace.detail.route", "Route")),
        ],
        ...(gateDebug ? { promptDebug: gateDebug } : {}),
      },
    );

    const needsUserSummary = route === "user" || route === "mix";
    const needsProjectMemory = route === "project" || route === "mix";
    const isGeneralWorkspace = this.repository.getWorkspaceMode() === "general";
    const userSummary = needsUserSummary
      ? this.repository.getUserSummary()
      : { identityBackground: [], files: [] };
    let projectMeta = needsProjectMemory
      ? (this.repository.getFileMemoryStore().getProjectMeta() ?? null)
      : null;
    let selectedProject: ReadableProjectCatalogEntry | null = null;
    let selectedProjectReason = "";
    let projectShortlist: ProjectShortlistCandidate[] = [];
    pushStep(
      trace,
      "user_base_loaded",
      "User Base Loaded",
      !needsUserSummary ? "skipped" : hasUserSummary(userSummary) ? "success" : "warning",
      !needsUserSummary ? `route=${route}` : "global user profile",
      !needsUserSummary
        ? "Current route does not require user identity background."
        : hasUserSummary(userSummary)
          ? "Attached compact global user profile."
          : "No stable user profile was available.",
      {
        titleI18n: traceI18n("trace.step.user_base_loaded", "User Base Loaded"),
        details: [
          kvDetail("user-summary", "User Profile", [
            { label: "route", value: route },
            { label: "required", value: needsUserSummary ? "yes" : "no" },
            { label: "identityBackground", value: userSummary.identityBackground.length },
          ], traceI18n("trace.detail.user_profile", "User Profile")),
          ...(userSummary.files.length > 0
            ? [listDetail(
                "user-summary-files",
                "Source Files",
                userSummary.files.map((file) => `${file.relativePath} | ${file.updatedAt}`),
                traceI18n("trace.detail.source_files", "Source Files"),
              )]
            : []),
        ],
      },
    );

    if (needsProjectMemory && isGeneralWorkspace) {
      const catalog = this.repository.listReadableProjectCatalog();
      projectShortlist = buildProjectShortlist(catalog, query, recentUserMessages(options.recentMessages));
      pushStep(
        trace,
        "project_shortlist_built",
        "Project Shortlist Built",
        projectShortlist.length > 0 ? "success" : "warning",
        `${catalog.length} readable projects`,
        projectShortlist.length > 0
          ? `${projectShortlist.length} candidate projects are available for General recall.`
          : "No readable projects were available for General recall.",
        {
          details: [
            kvDetail("project-shortlist-summary", "Project Shortlist Summary", [
              { label: "catalog", value: catalog.length },
              { label: "shortlist", value: projectShortlist.length },
            ]),
            listDetail(
              "project-shortlist-items",
              "Shortlist",
              projectShortlist.map((item) => `${item.projectName} | ${item.projectId} | ${item.sourceType ?? "unknown"} | score=${item.score} | exact=${item.exact} | ${item.matchedText || "no-match"}`),
            ),
          ],
        },
      );
      if (projectShortlist.length > 0) {
        let projectSelectionDebug: RetrievalPromptDebug | undefined;
        const projectSelection = await this.extractor.selectRecallProject({
          query,
          recentUserMessages: recentUserMessages(options.recentMessages),
          shortlist: projectShortlist,
          allowEmpty: true,
          debugTrace: (debug) => {
            projectSelectionDebug = debug;
          },
        });
        const selectedProjectId = projectSelection.projectId;
        selectedProject = selectedProjectId
          ? this.repository.getReadableProject(selectedProjectId) ?? null
          : null;
        selectedProjectReason = projectSelection.reason || "";
        if (selectedProject) {
          projectMeta = selectedProject;
        }
        pushStep(
          trace,
          "project_selected",
          "Project Selected",
          selectedProject ? "success" : "warning",
          `${projectShortlist.length} candidates`,
          selectedProject
            ? `${selectedProject.projectName} selected for General recall.`
            : "General recall could not resolve a readable project.",
          {
            details: [
              jsonDetail("project-selected", "Project Selection", {
                selectedProjectId: selectedProjectId ?? null,
                selectedProjectName: selectedProject?.projectName ?? null,
                selectedProjectSource: selectedProject
                  ? selectedProject.sourceType === "workspace_external" ? "workspace_external" : "general_local"
                  : null,
                reason: selectedProjectReason || null,
              }),
            ],
            ...(projectSelectionDebug ? { promptDebug: projectSelectionDebug } : {}),
          },
        );
      }
    }

    const manifest = route === "user"
      ? this.repository.listMemoryEntries({
          kinds: ["user"],
          scope: "global",
          limit: MANIFEST_LIMIT,
          includeDeprecated: false,
        })
      : needsProjectMemory && isGeneralWorkspace
        ? selectedProject
          ? this.repository.listReadableProjectEntries(selectedProject.logicalProjectId, {
              kinds: ["project", "feedback"],
              includeDeprecated: false,
            }).slice(0, MANIFEST_LIMIT)
          : []
      : needsProjectMemory
        ? this.repository.listMemoryEntries({
            kinds: ["project", "feedback"],
            scope: "project",
            limit: MANIFEST_LIMIT,
            includeDeprecated: false,
          })
        : [];

    pushStep(
      trace,
      "manifest_scanned",
      "Manifest Scanned",
      manifest.length > 0 ? "success" : route === "none" ? "skipped" : "warning",
      needsProjectMemory
        ? isGeneralWorkspace
          ? `general project=${selectedProject?.projectName ?? "none"}`
          : "current workspace project memory"
        : `route=${route}`,
      manifest.length > 0 ? `${manifest.length} recall header entries ready.` : "No matching workspace memory files were available.",
      {
        titleI18n: traceI18n("trace.step.manifest_scanned", "Manifest Scanned"),
        details: [
          kvDetail("manifest-scan-summary", "Manifest Scan", [
            { label: "count", value: manifest.length },
            { label: "route", value: route },
            { label: "scope", value: route === "user" ? "global" : needsProjectMemory ? isGeneralWorkspace ? "general_selected_project" : "workspace_project" : "none" },
            { label: "limit", value: MANIFEST_LIMIT },
            { label: "workspaceHint", value: options.workspaceHint ?? "" },
          ], traceI18n("trace.detail.manifest_scan", "Manifest Scan")),
          listDetail(
            "manifest-scan-preview",
            "Sorted Candidates",
            manifest.map((entry) => `${entry.updatedAt} | ${entry.type} | ${entry.relativePath} | ${entry.description}`),
            traceI18n("trace.detail.sorted_candidates", "Sorted Candidates"),
          ),
        ],
      },
    );

    let selectionDebug: RetrievalPromptDebug | undefined;
    let selectedIds = manifest.length > 0
      ? await this.extractor.selectFileManifestEntries({
          query,
          route,
          recentUserMessages: recentUserMessages(options.recentMessages),
          ...(projectMeta ? { projectMeta } : {}),
          manifest,
          limit: route === "user" ? 1 : DEFAULT_SELECTION_LIMIT,
          debugTrace: (debug) => {
            selectionDebug = debug;
          },
        })
      : [];

    if (selectedIds.length === 0) {
      selectedIds = fallbackSelection(route, manifest);
    }

    pushStep(
      trace,
      "manifest_selected",
      "Manifest Selected",
      selectedIds.length > 0 ? "success" : manifest.length > 0 ? "warning" : "skipped",
      `${manifest.length} entries`,
      `${selectedIds.length} file ids selected.`,
      {
        titleI18n: traceI18n("trace.step.manifest_selected", "Manifest Selected"),
        details: [
          listDetail(
            "manifest-selection-input",
            "Manifest Candidate IDs",
            manifest.map((entry) => entry.relativePath),
            traceI18n("trace.detail.manifest_candidate_ids", "Manifest Candidate IDs"),
          ),
          listDetail(
            "selected-files",
            "Selected File IDs",
            selectedIds,
            traceI18n("trace.detail.selected_file_ids", "Selected File IDs"),
          ),
        ],
        ...(selectionDebug ? { promptDebug: selectionDebug } : {}),
      },
    );

    const records = selectedIds.length > 0
        ? this.repository.getMemoryRecordsByIds(selectedIds, RECALL_FILE_MAX_LINES)
        : [];

    pushStep(
      trace,
      "files_loaded",
      "Files Loaded",
      records.length > 0 ? "success" : selectedIds.length > 0 ? "warning" : "skipped",
      `${selectedIds.length} requested`,
      `${records.length} files loaded.`,
      {
        titleI18n: traceI18n("trace.step.files_loaded", "Files Loaded"),
        details: [
          listDetail("requested-files", "Requested IDs", selectedIds, traceI18n("trace.detail.requested_ids", "Requested IDs")),
          listDetail(
            "loaded-files",
            "Loaded Files",
            records.map((record) => `${record.relativePath} | ${record.updatedAt}`),
            traceI18n("trace.detail.loaded_files", "Loaded Files"),
          ),
        ],
      },
    );

    const context = route === "none"
      ? ""
      : renderContext(
          route,
          userSummary,
          projectMeta,
          records.map((record) => ({
            relativePath: record.relativePath,
            type: record.type,
            updatedAt: record.updatedAt,
            content: record.content,
          })),
        );

    pushStep(
      trace,
      "context_rendered",
      "Context Rendered",
      context ? "success" : route === "none" ? "skipped" : "warning",
      `${records.length} files${hasUserSummary(userSummary) ? " + user base" : ""}`,
      context ? "Memory context prepared." : "No recall context was prepared.",
      {
        titleI18n: traceI18n("trace.step.context_rendered", "Context Rendered"),
        details: [
          kvDetail("context-rendered-summary", "Context Summary", [
            { label: "route", value: route },
            { label: "userBaseInjected", value: hasUserSummary(userSummary) ? "yes" : "no" },
            { label: "projectMetaInjected", value: projectMeta ? "yes" : "no" },
            { label: "selectedProject", value: selectedProject?.projectName ?? "" },
            { label: "disambiguationRequired", value: isGeneralWorkspace && needsProjectMemory ? "yes" : "no" },
            { label: "fileCount", value: records.length },
            { label: "characters", value: context.length },
            { label: "lines", value: context ? context.split("\n").length : 0 },
          ], traceI18n("trace.detail.context_summary", "Context Summary")),
          ...(context
            ? [listDetail(
                "context-rendered-blocks",
                "Injected Blocks",
                [
                  ...(hasUserSummary(userSummary)
                    ? userSummary.files.map((file) => file.relativePath)
                    : []),
                  ...(projectMeta ? ["project.meta.md"] : []),
                  ...Array.from(new Set(records
                    .map((record) => record.relativePath)
                    .filter((relativePath) => !userSummary.files.some((file) => file.relativePath === relativePath)))),
                ],
                traceI18n("trace.detail.injected_blocks", "Injected Blocks"),
              )]
            : []),
        ],
      },
    );

    trace.finishedAt = nowIso();
    const elapsedMs = Date.now() - startedAtMs;
    const result = route === "none" && !context
      ? buildEmptyResult(query, trace, elapsedMs)
      : {
          query,
          intent: route,
          context,
          trace,
          debug: {
            mode: context ? "llm" as const : "local_fallback" as const,
            elapsedMs,
            cacheHit: false,
            path: mode,
            ...(selectedProject ? { resolvedProjectId: selectedProject.logicalProjectId } : {}),
            route,
            manifestCount: manifest.length,
            selectedFileIds: selectedIds,
          },
        } satisfies RetrievalResult;

    this.recallCache.set(cacheKey, {
      expiresAt: Date.now() + RECALL_CACHE_TTL_MS,
      result,
    });
    this.runtimeStats = {
      lastRecallMs: elapsedMs,
      recallTimeouts: this.runtimeStats.recallTimeouts,
      lastRecallMode: result.debug?.mode ?? "none",
      lastRecallPath: result.debug?.path ?? mode,
      lastRecallInjected: Boolean(result.context),
      lastRecallCacheHit: false,
    };
    return result;
  }
}
