import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  GatewayTransport,
  mapError,
  type GatewayConnectionOptions,
  type GatewayTransportClient,
} from "./transport.js";
import { HostedHookServer, type HostedHookConfig } from "./hook-server.js";
import { PilotDeckMcpServerImpl } from "./mcp-server.js";
import { AbortError, PilotDeckError } from "./types.js";
import type {
  CanUseTool,
  ForkSessionOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  PermissionRequestContext,
  PilotDeckAsyncHookResult,
  PilotDeckCommand,
  PilotDeckCancelSteerReceipt,
  PilotDeckCronDeleteResult,
  PilotDeckCronListResult,
  PilotDeckCronRunNowResult,
  PilotDeckCronStopResult,
  PilotDeckCronTask,
  PilotDeckContextUsage,
  PilotDeckFileEntry,
  PilotDeckInput,
  PilotDeckMcpServerConfig,
  PilotDeckMcpServer,
  PilotDeckMcpServerOptions,
  PilotDeckMcpPermissionModeOverrideInput,
  PilotDeckMcpSessionInput,
  PilotDeckMcpTransportConfig,
  PilotDeckMcpSetResult,
  PilotDeckMcpStatus,
  PilotDeckHookSyncJSONOutput,
  PilotDeckMessage,
  PilotDeckModel,
  PilotDeckOptions,
  PilotDeckConnectionOptions,
  PilotDeckClient,
  PilotDeckProject,
  PilotDeckPermissionMode,
  PilotDeckQuery,
  PilotDeckReloadResult,
  PilotDeckOutputStyle,
  PilotDeckOutputStyleSelection,
  PilotDeckResult,
  PilotDeckResolvedSettings,
  PilotDeckResolveSettingsOptions,
  PilotDeckLocalSettingsUpdate,
  PilotDeckLastTurnReplacement,
  PilotDeckLastTurnReplacementRunOptions,
  PilotDeckManagedSettings,
  PilotDeckServerInfo,
  PilotDeckSessionInfo,
  PilotDeckSession,
  PilotDeckSessionTranscript,
  PilotDeckSetMcpServersInput,
  PilotDeckToggleMcpServerInput,
  RestoreSessionTranscriptOptions,
  PilotDeckRunHandle,
  PilotDeckRunInput,
  PilotDeckSkill,
  PilotDeckSteerReceipt,
  PilotDeckToolDefinition,
  PilotDeckToolExtras,
  PilotDeckToolHandler,
  PilotDeckEmbeddedToolDefinition,
  PilotDeckUserMessage,
  PilotDeckUserDialogFormSchema,
  PilotDeckUserDialogChange,
  PilotDeckUserDialogRequest,
  PilotDeckUserDialogResult,
  PilotDeckWarmQuery,
  PrepareLastTurnReplacementOptions,
  ReadFileOptions,
  SessionMutationOptions,
} from "./types.js";

type GatewaySessionResult = { sessionKey: string };
type GatewayListResult = { sessions?: PilotDeckSessionInfo[]; nextCursor?: string };
type GatewayMessagesResult = { messages?: PilotDeckMessage[]; total?: number; nextCursor?: string };
type GatewayRestoreTranscriptResult = { sessionKey?: string; importedMessages?: number };
type GatewayMcpTransportConfig = Extract<PilotDeckMcpTransportConfig, { type: "stdio" | "streamable_http" | "sse" }>;
type GatewayAgentMcpServerSpec = string | Record<string, GatewayMcpTransportConfig>;
type GatewayAgentDefinition = Omit<import("./types.js").PilotDeckAgentDefinition, "mcpServers"> & {
  mcpServers?: Record<string, GatewayMcpTransportConfig> | GatewayAgentMcpServerSpec[];
};

function connectionOptions(options: Pick<PilotDeckOptions, "gatewayUrl" | "authToken" | "clientVersion" | "reconnect">): GatewayConnectionOptions {
  if (!options.gatewayUrl || !options.authToken) {
    throw new PilotDeckError({ code: "validation_error", message: "gatewayUrl and authToken are required; pass them in query options or createPilotDeckClient defaults." });
  }
  return { url: options.gatewayUrl, token: options.authToken, clientName: "sdk", clientVersion: options.clientVersion, reconnect: options.reconnect };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseUserDialogChoices(value: unknown): Array<{ value: string; label?: string; description?: string }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway select dialog must include 2-12 choices." });
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const choice = asRecord(item);
    if (typeof choice.value !== "string" || !choice.value.trim() || seen.has(choice.value)
      || choice.label !== undefined && typeof choice.label !== "string"
      || choice.description !== undefined && typeof choice.description !== "string") {
      throw new PilotDeckError({ code: "validation_error", message: `Gateway returned an invalid select choice at index ${index}.` });
    }
    seen.add(choice.value);
    return {
      value: choice.value,
      ...(typeof choice.label === "string" ? { label: choice.label } : {}),
      ...(typeof choice.description === "string" ? { description: choice.description } : {}),
    };
  });
}

function parseUserDialogFormSchema(value: unknown): PilotDeckUserDialogFormSchema {
  if (!isPlainRecord(value) || value.type !== "object") {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway form dialog must include an object schema." });
  }
  try {
    return structuredClone(value) as PilotDeckUserDialogFormSchema;
  } catch (cause) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "Gateway form dialog schema must be cloneable.",
      cause,
    });
  }
}

function parseSessionTranscript(value: unknown): PilotDeckSessionTranscript {
  const archive = asRecord(value);
  if (archive.schemaVersion !== 1 || archive.format !== "portable_text_messages" || !Array.isArray(archive.messages)) {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid portable session transcript archive." });
  }
  const messages = archive.messages.map((message, index) => {
    const record = asRecord(message);
    if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string" || !record.text.trim()) {
      throw new PilotDeckError({ code: "validation_error", message: `Gateway returned an invalid transcript message at index ${index}.` });
    }
    return { role: record.role, text: record.text } as PilotDeckSessionTranscript["messages"][number];
  });
  if (typeof archive.title !== "undefined" && typeof archive.title !== "string") {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid transcript title." });
  }
  return {
    schemaVersion: 1,
    format: "portable_text_messages",
    messages,
    ...(typeof archive.title === "string" ? { title: archive.title } : {}),
  };
}

function withoutAsyncMarker(output: PilotDeckHookSyncJSONOutput): Omit<PilotDeckHookSyncJSONOutput, "async"> {
  const { async: _async, ...syncOutput } = output;
  return syncOutput;
}

function normalizeUserDialogElicitationAnswer(value: unknown): {
  type: "answered";
  answers: Record<string, string | string[]>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
} {
  const payload = asRecord(value);
  const rawAnswers = payload.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "An answered elicitation dialog must return value.answers as a question-to-selection map.",
    });
  }
  const answers: Record<string, string | string[]> = {};
  for (const [question, answer] of Object.entries(rawAnswers)) {
    if (!question.trim()
      || (typeof answer !== "string" && (!Array.isArray(answer) || answer.some((item) => typeof item !== "string")))) {
      throw new PilotDeckError({
        code: "validation_error",
        message: "Elicitation answers must map non-empty question text to a string or string array.",
      });
    }
    answers[question] = typeof answer === "string" ? answer : [...answer];
  }
  const rawAnnotations = payload.annotations;
  if (rawAnnotations === undefined) return { type: "answered", answers };
  if (!rawAnnotations || typeof rawAnnotations !== "object" || Array.isArray(rawAnnotations)) {
    throw new PilotDeckError({ code: "validation_error", message: "Elicitation annotations must be an object when provided." });
  }
  const annotations: Record<string, { preview?: string; notes?: string }> = {};
  for (const [question, annotation] of Object.entries(rawAnnotations)) {
    const item = asRecord(annotation);
    if (!question.trim()
      || (item.preview !== undefined && typeof item.preview !== "string")
      || (item.notes !== undefined && typeof item.notes !== "string")) {
      throw new PilotDeckError({ code: "validation_error", message: "Elicitation annotations must contain string preview or notes fields." });
    }
    annotations[question] = {
      ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    };
  }
  return { type: "answered", answers, annotations };
}

function supportsUserDialogKind(
  options: Pick<PilotDeckOptions, "supportedDialogKinds">,
  kind: "elicitation" | "input" | "select" | "confirm" | "form",
): boolean {
  // Omission preserves the established onUserDialog -> elicitation adapter.
  return options.supportedDialogKinds === undefined
    ? kind === "elicitation"
    : options.supportedDialogKinds.includes(kind);
}

/**
 * PilotDeck has no provider safety classifier. Claude's auto mode therefore
 * maps to the existing default/ask path instead of granting any tool access.
 */
function gatewayTurnPermissionMode(
  mode: PilotDeckPermissionMode | undefined,
): "default" | "plan" | "bypassPermissions" | undefined {
  if (mode === "acceptEdits" || mode === "dontAsk" || mode === "auto") return "default";
  return mode;
}

function gatewayBasePermissionMode(
  mode: PilotDeckPermissionMode | undefined,
): "default" | "bypassPermissions" | undefined {
  if (mode === undefined) return undefined;
  return mode === "bypassPermissions" ? "bypassPermissions" : "default";
}

function validateOptions(options: PilotDeckOptions): void {
  if (options.continue && options.resume) {
    throw new PilotDeckError({ code: "validation_error", message: "continue and resume cannot be used together." });
  }
  if (options.resumeSessionAt !== undefined && (typeof options.resumeSessionAt !== "string" || !options.resumeSessionAt.trim())) {
    throw new PilotDeckError({ code: "validation_error", message: "resumeSessionAt must be a non-empty transcript entry id." });
  }
  if (options.resumeSessionAt !== undefined && !options.resume && !options.sessionId) {
    throw new PilotDeckError({ code: "validation_error", message: "resumeSessionAt requires resume or sessionId." });
  }
  if (options.resumeDropsTurn !== undefined && (typeof options.resumeDropsTurn !== "string" || !options.resumeDropsTurn.trim())) {
    throw new PilotDeckError({ code: "validation_error", message: "resumeDropsTurn must be a non-empty accepted-input entry id." });
  }
  if (options.resumeDropsTurn !== undefined && options.resumeSessionAt === undefined) {
    throw new PilotDeckError({ code: "validation_error", message: "resumeDropsTurn requires resumeSessionAt." });
  }
  if (options.persistSession === false && (options.sessionId || options.resume || options.continue || options.forkSession || options.resumeSessionAt)) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "persistSession=false requires a new session and cannot be combined with sessionId, resume, continue, forkSession, or resumeSessionAt.",
    });
  }
  if (options.promptSuggestions !== undefined && typeof options.promptSuggestions !== "boolean") {
    throw new PilotDeckError({ code: "validation_error", message: "promptSuggestions must be a boolean." });
  }
  // These are public Claude Options fields, but PilotDeck has no equivalent
  // ownership or lifecycle. Reject them explicitly so JavaScript callers do
  // not accidentally believe an option was applied when it was ignored.
  const unsupportedOptionKeys = [
    "agent", "pathToClaudeCodeExecutable",
    "env", "executable", "executableArgs", "extraArgs",
    "betas", "toolConfig", "allowDangerouslySkipPermissions",
    "permissionPromptToolName",
    "debug",
    "debugFile", "stderr", "spawnClaudeCodeProcess",
    "perTaskStopAffordance",

  ] as const;
  for (const key of unsupportedOptionKeys) {
    if ((options as Record<string, unknown>)[key] !== undefined) {
      throw new PilotDeckError({ code: "unsupported_capability", message: `${key} is not yet exposed by the Gateway SDK.` });
    }
  }
  if (options.sandbox !== undefined) normalizeSandbox(options.sandbox);
  if (options.pluginDelivery !== undefined && options.pluginDelivery !== "initialize") {
    throw new PilotDeckError({
      code: "unsupported_capability",
      message: "PilotDeck loads session plugins through Gateway initialization; pluginDelivery=argv has no Gateway process equivalent.",
    });
  }
  if (options.plugins !== undefined) {
    if (!Array.isArray(options.plugins) || options.plugins.length === 0) {
      throw new PilotDeckError({ code: "validation_error", message: "plugins must be a non-empty array of Gateway-local plugin directories." });
    }
    const paths = new Set<string>();
    for (const plugin of options.plugins) {
      if (!plugin || plugin.type !== "local" || typeof plugin.path !== "string" || !plugin.path.trim()) {
        throw new PilotDeckError({ code: "validation_error", message: "Each plugin must be a local plugin with a non-empty path." });
      }
      if (!isAbsolutePath(plugin.path)) {
        throw new PilotDeckError({ code: "validation_error", message: "Plugin paths must be absolute paths on the Gateway host." });
      }
      if (paths.has(plugin.path)) {
        throw new PilotDeckError({ code: "validation_error", message: `Plugin path is listed more than once: ${plugin.path}` });
      }
      paths.add(plugin.path);
    }
  }
  if (options.agentProgressSummaries !== undefined && typeof options.agentProgressSummaries !== "boolean") {
    throw new PilotDeckError({ code: "validation_error", message: "agentProgressSummaries must be a boolean." });
  }
  if (options.forwardSubagentText !== undefined && typeof options.forwardSubagentText !== "boolean") {
    throw new PilotDeckError({ code: "validation_error", message: "forwardSubagentText must be a boolean." });
  }
  if (options.onElicitation && options.onUserDialog && supportsUserDialogKind(options, "elicitation")) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "onElicitation and onUserDialog are alternative adapters for elicitation; omit elicitation from supportedDialogKinds or configure only one.",
    });
  }
  if (options.userDialogMode !== undefined && options.userDialogMode !== "manual") {
    throw unsupported(`userDialogMode=${String(options.userDialogMode)}`);
  }
  if (options.userDialogMode === "manual" && options.onUserDialog) {
    throw new PilotDeckError({ code: "validation_error", message: "userDialogMode manual and onUserDialog are mutually exclusive." });
  }
  if (options.userDialogMode === "manual" && options.supportedDialogKinds === undefined) {
    throw new PilotDeckError({ code: "validation_error", message: "userDialogMode manual requires supportedDialogKinds." });
  }
  if (options.userDialogMode === "manual" && options.supportedDialogKinds?.includes("elicitation")) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "userDialogMode manual supports only generic input, select, confirm, and form dialogs; native elicitation requires onElicitation or onUserDialog.",
    });
  }
  if (options.supportedDialogKinds !== undefined) {
    if (!options.onUserDialog && options.userDialogMode !== "manual") {
      throw new PilotDeckError({ code: "validation_error", message: "supportedDialogKinds requires onUserDialog or userDialogMode manual." });
    }
    if (!Array.isArray(options.supportedDialogKinds) || options.supportedDialogKinds.length === 0) {
      throw new PilotDeckError({
        code: "validation_error",
        message: "supportedDialogKinds must be a non-empty array.",
      });
    }
    if (new Set(options.supportedDialogKinds).size !== options.supportedDialogKinds.length) {
      throw new PilotDeckError({
        code: "validation_error",
        message: "supportedDialogKinds cannot contain duplicates.",
      });
    }
    if (options.supportedDialogKinds.some((kind) => kind !== "elicitation" && kind !== "input" && kind !== "select" && kind !== "confirm" && kind !== "form")) {
      throw new PilotDeckError({
        code: "unsupported_capability",
        message: "PilotDeck onUserDialog supports only elicitation and the experimental input, select, confirm, and form dialog kinds.",
      });
    }
  }
  if (options.skills !== undefined && options.skills !== "all") {
    if (!Array.isArray(options.skills)
      || options.skills.length === 0
      || options.skills.some((skill) => typeof skill !== "string" || !skill.trim())
      || new Set(options.skills).size !== options.skills.length) {
      throw new PilotDeckError({
        code: "validation_error",
        message: "skills must be \"all\" or a non-empty array of unique skill names.",
      });
    }
  }
  if (options.sessionStore && !options.projectKey) {
    throw new PilotDeckError({ code: "validation_error", message: "projectKey is required when sessionStore is configured." });
  }
  if (options.hookServer && !options.hooks) {
    throw new PilotDeckError({ code: "validation_error", message: "hookServer requires hooks." });
  }
  if (options.permissionPrompts !== undefined && options.permissionPrompts !== "host" && options.permissionPrompts !== "none") {
    throw new PilotDeckError({ code: "validation_error", message: "permissionPrompts must be host or none." });
  }
  if (options.loadTimeoutMs !== undefined && (!Number.isFinite(options.loadTimeoutMs) || options.loadTimeoutMs <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "loadTimeoutMs must be a positive finite number." });
  }
  if (options.includeHookEvents !== undefined && typeof options.includeHookEvents !== "boolean") {
    throw new PilotDeckError({ code: "validation_error", message: "includeHookEvents must be a boolean." });
  }
  if (options.fallbackModel !== undefined && (typeof options.fallbackModel !== "string" || !options.fallbackModel.trim())) {
    throw new PilotDeckError({ code: "validation_error", message: "fallbackModel must be a non-empty Gateway model catalog reference." });
  }
  if (options.thinking?.type !== "disabled" && options.thinking?.display === "summarized") {
    throw new PilotDeckError({ code: "unsupported_capability", message: "PilotDeck exposes raw thinking deltas but does not provide Claude-style summarized thinking display." });
  }
  if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null
    && (!Number.isInteger(options.maxThinkingTokens) || options.maxThinkingTokens < 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "maxThinkingTokens must be a non-negative integer or null." });
  }
  if (options.reconnect) {
    const { maxAttempts, initialDelayMs, maxDelayMs, jitter } = options.reconnect;
    if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
      throw new PilotDeckError({ code: "validation_error", message: "reconnect.maxAttempts must be a positive integer." });
    }
    if (initialDelayMs !== undefined && (!Number.isFinite(initialDelayMs) || initialDelayMs < 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "reconnect.initialDelayMs must be non-negative." });
    }
    if (maxDelayMs !== undefined && (!Number.isFinite(maxDelayMs) || maxDelayMs < 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "reconnect.maxDelayMs must be non-negative." });
    }
    if (jitter !== undefined && (!Number.isFinite(jitter) || jitter < 0 || jitter > 1)) {
      throw new PilotDeckError({ code: "validation_error", message: "reconnect.jitter must be between 0 and 1." });
    }
    if (initialDelayMs !== undefined && maxDelayMs !== undefined && maxDelayMs < initialDelayMs) {
      throw new PilotDeckError({ code: "validation_error", message: "reconnect.maxDelayMs must be at least initialDelayMs." });
    }
  }
  if (options.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt)
      && options.systemPrompt.type === "preset") {
      throw new PilotDeckError({ code: "unsupported_capability", message: "The Claude Code preset systemPrompt has no PilotDeck Gateway equivalent." });
    }
    normalizeSystemPrompt(options.systemPrompt);
  }
  if (options.tools && !Array.isArray(options.tools)) {
    throw new PilotDeckError({ code: "unsupported_capability", message: "PilotDeck tool names differ from the Claude Code preset; pass an explicit PilotDeck tool-name array instead." });
  }
  for (const [field, value] of [["allowedTools", options.allowedTools], ["disallowedTools", options.disallowedTools]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some((tool) => typeof tool !== "string" || !tool.trim()))) {
      throw new PilotDeckError({ code: "validation_error", message: `${field} must contain non-empty tool names.` });
    }
  }
  validateDeferredTools(options.deferredTools, "deferredTools");
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "maxTurns must be a positive integer." });
  }
  if (options.maxBudgetUsd !== undefined && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "maxBudgetUsd must be a positive finite number." });
  }
  if (options.taskBudget !== undefined
    && (typeof options.taskBudget !== "object" || options.taskBudget === null
      || !Number.isFinite(options.taskBudget.total) || options.taskBudget.total <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "taskBudget.total must be a positive finite USD amount." });
  }
  if (options.taskBudget?.scope !== undefined
    && options.taskBudget.scope !== "session" && options.taskBudget.scope !== "project") {
    throw new PilotDeckError({ code: "validation_error", message: "taskBudget.scope must be session or project when provided." });
  }
  if (options.taskBudget?.projectRetentionMs !== undefined
    && (!Number.isSafeInteger(options.taskBudget.projectRetentionMs) || options.taskBudget.projectRetentionMs <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "taskBudget.projectRetentionMs must be a positive safe integer in milliseconds." });
  }
  if (options.taskBudget?.projectRetentionMs !== undefined && options.taskBudget.scope !== "project") {
    throw new PilotDeckError({ code: "validation_error", message: "taskBudget.projectRetentionMs requires taskBudget.scope to be project." });
  }
  if (options.outputStyle !== undefined && (typeof options.outputStyle !== "string" || !options.outputStyle.trim())) {
    throw new PilotDeckError({ code: "validation_error", message: "outputStyle must be a non-empty style name." });
  }
  if (options.additionalDirectories?.some((directory) => !isAbsolutePath(directory))) {
    throw new PilotDeckError({ code: "validation_error", message: "additionalDirectories must contain absolute paths." });
  }
  if (options.toolAliases && Object.entries(options.toolAliases).some(([from, to]) => !from.trim() || !to.trim())) {
    throw new PilotDeckError({ code: "validation_error", message: "toolAliases must be a non-empty string-to-string map." });
  }
  if (options.outputFormat && !isPilotDeckJsonSchema(options.outputFormat.schema)) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "outputFormat.schema must use the PilotDeck JSON-schema subset (type/properties/required/items/enum/additionalProperties).",
    });
  }
  if (options.mcpServers) {
    for (const [name, server] of Object.entries(options.mcpServers)) {
      if (!name.trim()) throw new PilotDeckError({ code: "validation_error", message: "MCP server names must not be empty." });
      if (isHostedMcpServer(server)) continue;
      if (server.type === "stdio" && !server.command.trim()) {
        throw new PilotDeckError({ code: "validation_error", message: `MCP server ${name} requires a command.` });
      }
      if ((server.type === "http" || server.type === "streamable_http" || server.type === "sse") && !server.url.trim()) {
        throw new PilotDeckError({ code: "validation_error", message: `MCP server ${name} requires a URL.` });
      }
      if (server.type !== "stdio" && server.type !== "http" && server.type !== "streamable_http" && server.type !== "sse") {
        throw new PilotDeckError({
          code: "unsupported_capability",
          message: `MCP server ${name} uses unsupported Claude transport ${String(server.type)}. PilotDeck supports stdio, streamable_http, and legacy sse.`,
        });
      }
      validateDeferredMcpTools((server as { deferredTools?: unknown }).deferredTools, `MCP server ${name}`);
    }
  }
  if (options.agents) {
    for (const [name, agent] of Object.entries(options.agents)) {
      if (!name.trim()) throw new PilotDeckError({ code: "validation_error", message: "Agent names must not be empty." });
      if (!agent || typeof agent !== "object" || !agent.description?.trim() || !agent.prompt?.trim()) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} requires a non-empty description and prompt.` });
      }
      if (agent.background !== undefined && typeof agent.background !== "boolean") {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} background must be a boolean when provided.` });
      }
      if (agent.observer !== undefined && (typeof agent.observer !== "string" || !agent.observer.trim())) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} observer must name a non-empty AgentDefinition.` });
      }
      if (agent.observerMessage !== undefined && typeof agent.observerMessage !== "string") {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} observerMessage must be a string when provided.` });
      }
      if (agent.observerMessage?.trim() && !agent.observer) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} observerMessage requires observer.` });
      }
      if (agent.tools?.some((tool) => !tool.trim()) || agent.disallowedTools?.some((tool) => !tool.trim())) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} tools and disallowedTools must contain non-empty names.` });
      }
      if (agent.maxTurns !== undefined && (!Number.isInteger(agent.maxTurns) || agent.maxTurns <= 0)) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} maxTurns must be a positive integer.` });
      }
      if (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model.trim())) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} model must be a non-empty model catalog reference.` });
      }
      for (const [field, value] of [
        ["initialPrompt", agent.initialPrompt],
        ["criticalSystemReminder_EXPERIMENTAL", agent.criticalSystemReminder_EXPERIMENTAL],
      ] as const) {
        if (value !== undefined && (typeof value !== "string" || !value.trim())) {
          throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} ${field} must be a non-empty string when provided.` });
        }
      }
      if (agent.effort !== undefined && !["low", "medium", "high"].includes(agent.effort)) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} effort must be low, medium, or high.` });
      }
      if (agent.permissionMode !== undefined && !["default", "plan", "bypassPermissions"].includes(agent.permissionMode)) {
        throw new PilotDeckError({ code: "unsupported_capability", message: `Agent ${name} permissionMode has no native equivalent.` });
      }
      if (agent.skills !== undefined && agent.skills !== "all") {
        if (!Array.isArray(agent.skills)
          || agent.skills.length === 0
          || agent.skills.some((skill) => typeof skill !== "string" || !skill.trim())
          || new Set(agent.skills).size !== agent.skills.length) {
          throw new PilotDeckError({
            code: "validation_error",
            message: `Agent ${name} skills must be "all" or a non-empty array of unique skill names.`,
          });
        }
      }
      if (agent.memory !== undefined && agent.memory !== "inherit" && agent.memory !== "disabled") {
        throw new PilotDeckError({
          code: "validation_error",
          message: `Agent ${name} memory must be "inherit" or "disabled".`,
        });
      }
      if (agent.mcpServers !== undefined) validateAgentMcpServers(name, agent.mcpServers);
    }
    for (const [name, agent] of Object.entries(options.agents)) {
      if (!agent.observer) continue;
      if (agent.observer === name) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${name} cannot observe itself.` });
      }
      if (!options.agents[agent.observer]) {
        throw new PilotDeckError({
          code: "validation_error",
          message: `Agent ${name} observer ${agent.observer} is not defined in options.agents.`,
        });
      }
    }
  }
}

function mapPublicMessage(raw: PilotDeckMessage, sessionId?: string): PilotDeckMessage {
  const event = asRecord(raw);
  const type = String(event.type ?? "unknown");
  const mapped: PilotDeckMessage = { type, ...event, sessionId: sessionId ?? (event.sessionId as string | undefined), runId: event.runId as string | undefined, sequence: event.sequence as number | undefined };
  const names: Record<string, string> = {
    turn_started: "turn.started",
    input_accepted: "user.accepted",
    assistant_text_delta: "assistant.message",
    assistant_thinking_delta: "assistant.thinking",
    subagent_text_delta: "subagent.message",
    tool_call_started: "tool.started",
    tool_progress: "tool.progress",
    prompt_suggestion: "prompt_suggestion",
    tool_call_finished: event.ok === false ? "tool.failed" : "tool.completed",
    tool_result_detail_available: "tool.result_detail",
    permission_request: "permission.requested",
    hook_started: "hook.started",
    hook_response: "hook.response",
    hook_async_result: "hook.async_result",
    elicitation_request: "elicitation.requested",
    elicitation_cancelled: "elicitation.cancelled",
    user_dialog_request: "user_dialog.requested",
    user_dialog_cancelled: "user_dialog.cancelled",
    structured_output: "structured_output",
    context_budget: "context.usage",
    turn_completed: "result",
    error: "error",
  };
  mapped.type = names[type] ?? (type.includes(".") ? type : "pilotdeck." + type);
  if (type === "turn_completed") {
    mapped.status = "completed";
    mapped.output = event.result;
    mapped.finishReason = event.finishReason;
  }
  if (type === "error") mapped.status = "failed";
  if (type === "permission_denied") mapped.type = "permission.denied";
  if (type === "context_budget") {
    // Keep the compact legacy usage projection while preserving every native
    // diagnostic field added to the Gateway context-budget event.
    const contextKeys = [
      "used", "displayUsed", "budgetUsed", "localEstimateTokens", "displayTokens",
      "estimateSource", "usageTokens", "calibrationActualInputTokens", "calibrationEstimatedInputTokens",
      "total", "totalContextTokens", "maxContextTokens", "effectiveTotal", "effectiveContextTokens",
      "maxOutputTokens", "reservedOutputTokens", "warningRatio", "blockingRatio", "ratio", "state",
      "source", "exact", "estimatorError", "breakdown",
    ];
    mapped.usage = Object.fromEntries(contextKeys.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
  }
  return mapped;
}

function parsePendingUserDialog(message: PilotDeckMessage, sessionId: string): PilotDeckUserDialogRequest {
  const requestId = String(message.requestId ?? "");
  const common = {
    sessionId,
    ...(typeof message.runId === "string" ? { runId: message.runId } : {}),
    toolCallId: String(message.toolCallId),
    toolName: String(message.toolName),
    prompt: String(message.prompt),
  };
  if (!requestId || !common.toolCallId || !common.toolName || !common.prompt) {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid pending user dialog." });
  }
  if (message.dialogKind === "input") {
    return {
      requestId,
      dialogKind: "input",
      payload: {
        ...common,
        ...(typeof message.placeholder === "string" ? { placeholder: message.placeholder } : {}),
        ...(message.allowEmpty === true ? { allowEmpty: true } : {}),
      },
    };
  }
  if (message.dialogKind === "select") {
    const choices = parseUserDialogChoices(message.choices);
    const defaultValue = typeof message.defaultValue === "string" ? message.defaultValue : undefined;
    if (defaultValue !== undefined && !choices.some((choice) => choice.value === defaultValue)) {
      throw new PilotDeckError({ code: "validation_error", message: "Gateway select dialog defaultValue does not exist in choices." });
    }
    return { requestId, dialogKind: "select", payload: { ...common, choices, ...(defaultValue !== undefined ? { defaultValue } : {}) } };
  }
  if (message.dialogKind === "confirm") {
    if (message.defaultValue !== undefined && typeof message.defaultValue !== "boolean") {
      throw new PilotDeckError({ code: "validation_error", message: "Gateway confirm dialog defaultValue must be boolean." });
    }
    return {
      requestId,
      dialogKind: "confirm",
      payload: {
        ...common,
        ...(typeof message.confirmLabel === "string" ? { confirmLabel: message.confirmLabel } : {}),
        ...(typeof message.cancelLabel === "string" ? { cancelLabel: message.cancelLabel } : {}),
        ...(typeof message.defaultValue === "boolean" ? { defaultValue: message.defaultValue } : {}),
      },
    };
  }
  if (message.dialogKind === "form") {
    return { requestId, dialogKind: "form", payload: { ...common, schema: parseUserDialogFormSchema(message.schema) } };
  }
  throw new PilotDeckError({ code: "unsupported_capability", message: "Gateway emitted an unsupported user dialog kind." });
}

function parseUserDialogRecord(message: PilotDeckMessage, sessionId: string): import("./types.js").PilotDeckUserDialogRecord {
  const record = asRecord(message);
  if (record.type !== "user_dialog_terminated") {
    const pending = parsePendingUserDialog(mapPublicMessage(message, sessionId), sessionId);
    if (record.lease === undefined) return pending;
    const lease = asRecord(record.lease);
    if (typeof lease.expiresAt !== "string" || !lease.expiresAt.trim()) {
      throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid user dialog lease." });
    }
    return { ...pending, lease: { expiresAt: lease.expiresAt } };
  }
  if (record.reason !== "gateway_restarted" || typeof record.terminatedAt !== "string") {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid recovered user dialog." });
  }
  if (record.recovery !== undefined && record.recovery !== "next_turn_context") {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an unsupported recovered dialog mode." });
  }
  const request = asRecord(record.request);
  if (request.type !== "user_dialog_request") {
    throw new PilotDeckError({ code: "validation_error", message: "Gateway recovered dialog is missing its request payload." });
  }
  return {
    type: "user_dialog_terminated",
    request: parsePendingUserDialog(
      mapPublicMessage({ ...request, type: "user_dialog_request" } as PilotDeckMessage, sessionId),
      sessionId,
    ),
    reason: "gateway_restarted",
    terminatedAt: record.terminatedAt,
    ...(record.recovery === "next_turn_context" ? { recovery: "next_turn_context" as const } : {}),
  };
}

function parseUserDialogChange(value: unknown, sessionId: string, projectKey?: string): PilotDeckUserDialogChange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const change = value as Record<string, unknown>;
  if (change.sessionKey !== sessionId || typeof change.type !== "string") return undefined;
  if (projectKey !== undefined && change.projectKey !== undefined && change.projectKey !== projectKey) return undefined;
  const project = typeof change.projectKey === "string" && change.projectKey.trim()
    ? { projectKey: change.projectKey }
    : {};
  if (change.type === "requested") {
    try {
      const request = parseUserDialogRecord(change.request as PilotDeckMessage, sessionId);
      if ("type" in request) return undefined;
      return { type: "requested", sessionId, ...project, request };
    } catch {
      return undefined;
    }
  }
  if (change.type === "lease_changed"
    && typeof change.requestId === "string"
    && (change.action === "claimed" || change.action === "released" || change.action === "expired")) {
    if (change.expiresAt !== undefined && (typeof change.expiresAt !== "string" || !change.expiresAt.trim())) return undefined;
    return {
      type: "lease_changed",
      sessionId,
      ...project,
      requestId: change.requestId,
      action: change.action,
      ...(typeof change.expiresAt === "string" ? { expiresAt: change.expiresAt } : {}),
    };
  }
  if (change.type === "settled" && typeof change.requestId === "string" && typeof change.reason === "string") {
    return { type: "settled", sessionId, ...project, requestId: change.requestId, reason: change.reason };
  }
  return undefined;
}

function userDialogResponsePayload(result: PilotDeckUserDialogResult): { behavior: "answered"; value: unknown } | { behavior: "cancelled"; reason?: string } {
  if (result.behavior === "answered") {
    if (!("value" in result) || result.value === undefined) {
      throw new PilotDeckError({ code: "validation_error", message: "An answered user dialog requires a value." });
    }
    return { behavior: "answered", value: result.value };
  }
  if (result.behavior === "cancelled") {
    if (result.reason !== undefined && typeof result.reason !== "string") {
      throw new PilotDeckError({ code: "validation_error", message: "A cancelled user dialog reason must be a string." });
    }
    return { behavior: "cancelled", ...(result.reason ? { reason: result.reason } : {}) };
  }
  throw new PilotDeckError({ code: "validation_error", message: "User dialog result behavior must be answered or cancelled." });
}

function normalizeUserDialogLeaseId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: `${label} must be a non-empty string when provided.` });
  }
  return value.trim();
}

function isPartialAssistantMessage(message: PilotDeckMessage): boolean {
  return message.type === "assistant.message" || message.type === "assistant.thinking";
}

class PilotDeckQueryImpl implements PilotDeckQuery {
  private readonly transport: GatewayTransportClient;
  private sessionKey?: string;
  private runId?: string;
  private stream?: AsyncIterator<PilotDeckMessage>;
  private initialized = false;
  private done = false;
  private finalResult?: PilotDeckResult;
  private terminalSeen = false;
  private readonly outputChunks: string[] = [];
  private structuredOutput?: unknown;
  private readonly abortController: AbortController;
  private readonly options: PilotDeckOptions;
  private readonly permissionHandler?: CanUseTool;
  private readonly prompt: string | AsyncIterable<PilotDeckUserMessage>;
  private initialization?: import("./types.js").PilotDeckInitializationResult;
  private latestUsage?: import("./types.js").PilotDeckUsage;
  private latestContextUsage?: PilotDeckContextUsage;
  private readonly abortListener: () => void;
  private mirrorQueue: Array<{ type: string; uuid: string; timestamp: string; event: PilotDeckMessage }> = [];
  private mirrorTimer?: ReturnType<typeof setTimeout>;
  private mirrorFlush: Promise<void> = Promise.resolve();
  private ephemeralSessionDeleted = false;
  private thinkingDisplay?: "summarized" | "omitted";
  private hostedHookServer?: HostedHookServer;
  private latestSteerItemId?: string;
  private initializationPromise?: Promise<void>;
  private initializationTimeoutError?: PilotDeckError;
  private serverInfoSnapshot?: PilotDeckServerInfo;

  constructor(
    prompt: string | AsyncIterable<PilotDeckUserMessage>,
    options: PilotDeckOptions,
    transport?: GatewayTransportClient,
    private readonly requestedRunId?: string,
  ) {
    this.options = options;
    this.permissionHandler = options.canUseTool;
    this.abortController = options.abortController ?? new AbortController();
    this.transport = transport ?? new GatewayTransport({
      ...connectionOptions(options),
      requestTimeoutMs: options.timeoutMs ?? 30_000,
    });
    this.prompt = prompt;
    this.thinkingDisplay = options.thinking?.type === "disabled" ? undefined : options.thinking?.display;
    this.abortListener = () => {
      if (this.done) return;
      if (!this.initialized) {
        this.done = true;
        this.finalResult = { status: "aborted", reason: "abort_controller" };
        this.transport.close();
        return;
      }
      void this.interrupt().catch(() => this.close());
    };
    if (this.options.abortController?.signal.aborted) this.abortListener();
    else this.options.abortController?.signal.addEventListener("abort", this.abortListener, { once: true });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initializationPromise;
    this.initializationPromise = this.initializeInternal();
    return this.initializationPromise;
  }

  private async initializeInternal(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    validateOptions(this.options);
    const loadTimeoutMs = this.options.loadTimeoutMs;
    if (loadTimeoutMs !== undefined) {
      await withTimeout(this.initializeInternalWithoutTimeout(), loadTimeoutMs, () => {
        this.initializationTimeoutError = new PilotDeckError({ code: "timeout", message: `SDK initialization exceeded ${loadTimeoutMs}ms.` });
        this.transport.close();
        // Initialization may be waiting on an SDK-owned HTTP hook/MCP
        // listener. Close those resources even though the underlying promise
        // is allowed to settle in the background.
        void this.closeHostedHooks();
        const ownedMcpServers = Object.values(this.options.mcpServers ?? {}).filter(isHostedMcpServer);
        void Promise.allSettled(ownedMcpServers.map((server) => server.close()));
        return this.initializationTimeoutError;
      });
      return;
    }
    await this.initializeInternalWithoutTimeout();
  }

  private async initializeInternalWithoutTimeout(): Promise<void> {
    this.serverInfoSnapshot = await this.transport.connect();
    this.sessionKey = this.options.sessionId ?? this.options.resume;
    if (!this.sessionKey && this.options.continue) {
      const listed = await this.transport.request("list_sessions", {
        projectKey: this.options.projectKey,
        limit: 1,
      }) as GatewayListResult;
      this.sessionKey = listed.sessions?.[0]?.sessionKey ?? listed.sessions?.[0]?.sessionId;
    }
    if (this.options.resumeSessionAt !== undefined) {
      if (!this.sessionKey) {
        throw new PilotDeckError({ code: "validation_error", message: "resumeSessionAt requires resume or sessionId." });
      }
      const forked = await this.transport.request("fork_session", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
        fromEntryId: this.options.resumeSessionAt,
        resumeAt: true,
        ...(this.options.resumeDropsTurn !== undefined ? { resumeDropsTurn: this.options.resumeDropsTurn } : {}),
      }) as { newSessionKey?: string };
      if (!forked.newSessionKey) throw new PilotDeckError({ code: "server_error", message: "Gateway did not return a resumed session id." });
      this.sessionKey = forked.newSessionKey;
    } else if (this.options.forkSession) {
      if (!this.sessionKey) {
        throw new PilotDeckError({ code: "validation_error", message: "forkSession requires resume or sessionId." });
      }
      const messages = await this.transport.request("read_session_messages", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
      }) as GatewayMessagesResult;
      const forkPoint = [...(messages.messages ?? [])].reverse()
        .map((message) => String((message as any).entryId ?? (message as any).id ?? ""))
        .find(Boolean);
      if (!forkPoint) throw new PilotDeckError({ code: "not_found", message: `Session ${this.sessionKey} has no forkable transcript entry.` });
      const forked = await this.transport.request("fork_session", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
        fromEntryId: forkPoint,
      }) as { newSessionKey?: string };
      if (!forked.newSessionKey) throw new PilotDeckError({ code: "server_error", message: "Gateway did not return a forked session id." });
      this.sessionKey = forked.newSessionKey;
    }
    if (!this.sessionKey) {
      const created = await this.transport.request("new_session", {
        projectKey: this.options.projectKey,
        channelKey: this.options.channelKey ?? "api_server",
      }) as GatewaySessionResult;
      this.sessionKey = created.sessionKey;
    } else {
      await this.transport.request("resume_session", { sessionKey: this.sessionKey });
    }
    // An ephemeral session never has a listable or resumable transcript, so a
    // title has no durable surface. More importantly, rename_session writes
    // metadata before submit_turn config reaches the Gateway.
    if (this.options.title !== undefined && this.options.persistSession !== false) {
      await this.transport.request("rename_session", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
        value: this.options.title,
      });
    }
    if (this.options.mcpServers) {
      await this.setMcpServers(this.options.mcpServers);
    }
    const thinkingOverride = normalizeThinkingOption(this.options);
    if (thinkingOverride !== undefined) {
      await this.transport.request("set_session_thinking", {
        sessionKey: this.sessionKey,
        thinking: thinkingOverride,
      });
    }
    const prompt = typeof this.prompt === "string" ? this.prompt : await collectPrompt(this.prompt);
    const modelOverride = this.options.model ? await this.resolveModelOverride(this.options.model) : undefined;
    const explicitTools = Array.isArray(this.options.tools) ? this.options.tools : undefined;
    const hostedHooks = await this.startHostedHooks();
    const explicitSessionConfig = sdkSessionConfig(this.options, hostedHooks);
    // A current Gateway may apply host-owned defaults only to sessions that
    // entered through the SDK protocol. Preserve compatibility with older
    // servers by sending this empty marker only after capability negotiation.
    const sessionConfig = explicitSessionConfig
      ?? (this.serverInfoSnapshot?.capabilities?.includes("sdk_session_defaults") ? {} : undefined);
    const events = this.transport.stream("submit_turn", {
      sessionKey: this.sessionKey,
      channelKey: this.options.channelKey ?? "api_server",
      projectKey: this.options.projectKey,
      message: prompt,
      workspaceCwd: this.options.cwd,
      maxTurns: this.options.maxTurns,
      maxBudgetUsd: this.options.maxBudgetUsd,
      timeoutMs: this.options.timeoutMs,
      canPrompt: this.options.permissionMode !== "dontAsk"
        && this.options.permissionPrompts !== "none"
        && Boolean(this.options.canUseTool),
      canElicit: Boolean(
        this.options.onElicitation
        || (this.options.onUserDialog && supportsUserDialogKind(this.options, "elicitation")),
      ),
      mode: gatewayTurnPermissionMode(this.options.permissionMode),
      basePermissionMode: gatewayBasePermissionMode(this.options.permissionMode),
      ...(this.options.permissionMode === "acceptEdits" || this.options.permissionMode === "dontAsk"
        ? { sdkPermissionMode: this.options.permissionMode }
        : {}),
      allowedTools: explicitTools ?? this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      ...(sessionConfig ? { sdkSessionConfig: sessionConfig } : {}),
      modelOverride,
      ...(this.requestedRunId ? { runId: this.requestedRunId } : {}),
    });
    this.runId = this.requestedRunId;
    this.stream = events[Symbol.asyncIterator]();
  }

  async next(): Promise<IteratorResult<PilotDeckMessage>> {
    if (this.done) return { done: true, value: undefined as never };
    try {
      await this.initialize();
      if (!this.stream) return { done: true, value: undefined as never };
      const item = await this.stream.next();
      if (item.done) {
        await this.flushMirror();
        this.done = true;
        if (!this.finalResult) {
          this.finalResult = { status: "result_unknown", recovery: { sessionId: this.sessionKey, runId: this.runId } };
        }
        // `turn_completed` is emitted before AgentSession dispatches
        // SessionEnd. Keep SDK-hosted callbacks reachable until the Gateway
        // stream itself closes so the final native lifecycle hook is not
        // turned into a connection failure by the SDK client.
        await this.closeHostedHooks();
        await this.deleteEphemeralSession();
        return { done: true, value: undefined as never };
      }
      const mapped = mapPublicMessage(item.value, this.sessionKey);
      if (mapped.type === "assistant.thinking" && this.thinkingDisplay === "omitted") return this.next();
      if (mapped.type === "assistant.message" && typeof mapped.text === "string") this.outputChunks.push(mapped.text);
      if (isPartialAssistantMessage(mapped) && this.options.includePartialMessages !== true) return this.next();
      await this.mirrorEvent(mapped);
      if (mapped.type === "turn.started" && typeof mapped.runId === "string") this.runId = mapped.runId;
      if (mapped.type === "structured_output") this.structuredOutput = mapped.payload;
      if (mapped.type === "context.usage") {
        this.latestContextUsage = asRecord(mapped.usage) as PilotDeckContextUsage;
      }
      if (mapped.type === "permission.requested" && this.permissionHandler) await this.handlePermission(mapped);
      if (mapped.type === "elicitation.requested" && (this.options.onElicitation || this.options.onUserDialog)) {
        await this.handleElicitation(mapped);
      }
      if (mapped.type === "user_dialog.requested" && this.options.onUserDialog) {
        await this.handleUserDialog(mapped);
      }
      if (mapped.type === "result") {
        if (this.terminalSeen) return this.next();
        this.terminalSeen = true;
        this.latestUsage = asRecord(mapped.usage) as import("./types.js").PilotDeckUsage;
        this.finalResult = { status: "completed", output: this.structuredOutput ?? (this.outputChunks.length ? this.outputChunks.join("") : undefined), usage: this.latestUsage, finishReason: mapped.finishReason as string | undefined };
        await this.flushMirror();
      }
      if (mapped.type === "error") {
        if (this.terminalSeen) return this.next();
        this.terminalSeen = true;
        const code = String(mapped.code ?? "server_error");
        const error = new PilotDeckError({ code, message: String(mapped.message ?? "Gateway error"), details: asRecord(mapped.detail) });
        this.finalResult = { status: code === "result_unknown" ? "result_unknown" : "failed", ...(code === "result_unknown" ? { recovery: { sessionId: this.sessionKey, runId: this.runId } } : { error }) } as PilotDeckResult;
        await this.flushMirror();
      }
      return { done: false, value: mapped };
    } catch (error) {
      this.done = true;
      await this.closeHostedHooks();
      const mapped = mapError(error);
      if (!this.terminalSeen && (mapped.code === "transport_error" || mapped.code === "timeout")) {
        this.finalResult = { status: "result_unknown", recovery: { sessionId: this.sessionKey, runId: this.runId } };
      } else {
        this.finalResult = { status: "failed", error: mapped };
      }
      throw mapped;
    }
  }

  async result(): Promise<PilotDeckResult> {
    while (!this.done) {
      try {
        await this.next();
      } catch {
        // The async iterator remains capable of surfacing the original error
        // to callers; result() is the stable Claude-like terminal facade and
        // returns recovery/failed state instead of throwing transport errors.
        break;
      }
    }
    return this.finalResult ?? { status: "result_unknown", recovery: { sessionId: this.sessionKey, runId: this.runId } };
  }

  async [Symbol.asyncDispose](): Promise<void> { this.close(); }

  async return(): Promise<IteratorResult<PilotDeckMessage>> { this.close(); return { done: true, value: undefined as never }; }
  async throw(error: unknown): Promise<IteratorResult<PilotDeckMessage>> { this.close(); throw error; }
  [Symbol.asyncIterator](): PilotDeckQuery { return this; }

  async steer(input: PilotDeckInput): Promise<PilotDeckSteerReceipt> {
    await this.initialize();
    if (!this.sessionKey || !this.runId) throw new PilotDeckError({ code: "conflict", message: "steer requires an active turn." });
    const itemId = randomUUID();
    const result = await this.transport.request("steer_turn", {
      sessionKey: this.sessionKey,
      runId: this.runId,
      itemId,
      message: userMessageText(input),
      projectKey: this.options.projectKey,
    }) as { accepted?: boolean; reason?: string };
    if (!result.accepted) {
      throw new PilotDeckError({ code: "conflict", message: `Steer input was not accepted: ${result.reason ?? "unknown reason"}` });
    }
    this.latestSteerItemId = itemId;
    return { itemId };
  }

  async cancelSteer(itemId = this.latestSteerItemId): Promise<PilotDeckCancelSteerReceipt> {
    await this.initialize();
    if (!this.sessionKey || !this.runId) throw new PilotDeckError({ code: "conflict", message: "cancelSteer requires an active turn." });
    if (!itemId) throw new PilotDeckError({ code: "validation_error", message: "itemId is required when there is no prior steer input." });
    const result = await this.transport.request("cancel_steer", {
      sessionKey: this.sessionKey,
      runId: this.runId,
      itemId,
    }) as { cancelled?: boolean; reason?: string };
    return { itemId, cancelled: result.cancelled === true, ...(result.reason ? { reason: result.reason } : {}) };
  }

  async submitAsyncHookResult(
    invocationId: string,
    output: PilotDeckHookSyncJSONOutput,
  ): Promise<PilotDeckAsyncHookResult> {
    if (!invocationId.trim()) throw new PilotDeckError({ code: "validation_error", message: "invocationId is required." });
    if ((output as { async?: unknown }).async === true) {
      throw new PilotDeckError({ code: "validation_error", message: "A deferred hook result must be synchronous output." });
    }
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    if (Array.isArray(this.serverInfoSnapshot?.capabilities)
      && !this.serverInfoSnapshot.capabilities.includes("async_hook_result")) {
      throw unsupported("submitAsyncHookResult");
    }
    return await this.transport.request("hook_async_result", {
      sessionKey: this.sessionKey,
      invocationId,
      output: withoutAsyncMarker(output),
    }) as PilotDeckAsyncHookResult;
  }

  async respondUserDialog(
    requestId: string,
    result: PilotDeckUserDialogResult,
    options?: { leaseId?: string },
  ): Promise<import("./types.js").PilotDeckUserDialogResponseReceipt> {
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    if (!requestId?.trim()) throw new PilotDeckError({ code: "validation_error", message: "requestId is required." });
    const leaseId = normalizeUserDialogLeaseId(options?.leaseId, "options.leaseId");
    const response = await this.transport.request("user_dialog_respond", {
      sessionKey: this.sessionKey,
      ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
      requestId,
      ...(leaseId ? { leaseId } : {}),
      result: userDialogResponsePayload(result),
    }) as { delivered?: boolean; recovered?: unknown; reason?: unknown };
    return {
      delivered: response.delivered === true,
      ...(response.recovered === true ? { recovered: true as const } : {}),
      ...(response.reason === "gateway_restarted" ? { reason: "gateway_restarted" as const } : {}),
    };
  }

  async abort(reason = "abort"): Promise<void> {
    await this.initialize();
    if (!this.sessionKey || this.done) return;
    await this.transport.request("abort_turn", { sessionKey: this.sessionKey, runId: this.runId, reason });
    this.terminalSeen = true;
    this.done = true;
    this.finalResult = { status: "aborted", reason };
    await this.closeHostedHooks();
    await this.deleteEphemeralSession();
    this.transport.close();
  }

  async interrupt(): Promise<undefined> {
    await this.abort("interrupt");
    return undefined;
  }

  async setPermissionMode(mode: PilotDeckPermissionMode): Promise<void> {
    if (mode !== "default" && mode !== "plan" && mode !== "bypassPermissions" && mode !== "auto") {
      throw unsupported(`setPermissionMode(${mode})`);
    }
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("set_permission_mode", {
      sessionKey: this.sessionKey,
      mode: gatewayTurnPermissionMode(mode),
    });
    this.options.permissionMode = mode;
  }

  async setMcpPermissionModeOverride(serverName: string, mode: "default" | "auto" | null): Promise<{ warning?: string }> {
    if (!serverName?.trim()) throw new PilotDeckError({ code: "validation_error", message: "serverName is required." });
    if (mode !== null && mode !== "default" && mode !== "auto") {
      throw new PilotDeckError({ code: "validation_error", message: `Unsupported MCP permission mode: ${mode}` });
    }
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    return await this.transport.request("set_mcp_permission_mode_override", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      serverName,
      mode,
    }) as { warning?: string };
  }

  async setModel(model?: string): Promise<void> {
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    const projectKey = this.options.projectKey;
    if (!projectKey) throw new PilotDeckError({ code: "validation_error", message: "projectKey is required to change the session model." });
    if (!model) {
      await this.transport.request("session_model_clear", { sessionKey: this.sessionKey, projectKey });
      this.options.model = undefined;
      return;
    }
    const models = await this.supportedModels();
    const requested = String(model);
    const matches = models.filter((candidate: any) => candidate?.id === requested || `${candidate?.provider}/${candidate?.model}` === requested || candidate?.model === requested);
    if (matches.length !== 1) throw new PilotDeckError({ code: "validation_error", message: `Model is not uniquely resolvable: ${requested}` });
    const selected: any = matches[0];
    await this.transport.request("session_model_set", { sessionKey: this.sessionKey, projectKey, selection: { mode: "model", provider: selected.provider, model: selected.model } });
    this.options.model = requested;
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: "summarized" | "omitted" | null): Promise<void> {
    if (maxThinkingTokens !== null && (!Number.isInteger(maxThinkingTokens) || maxThinkingTokens < 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "maxThinkingTokens must be a non-negative integer or null." });
    }
    if (thinkingDisplay === "summarized") throw unsupported("setMaxThinkingTokens(thinkingDisplay=summarized)");
    const thinking = maxThinkingTokens === null
      ? null
      : maxThinkingTokens === 0
        ? { enabled: false, mode: "off" as const }
        : { enabled: true, mode: "medium" as const, budgetTokens: maxThinkingTokens };
    if (thinkingDisplay !== undefined) this.thinkingDisplay = thinkingDisplay ?? undefined;
    if (!this.initialized) {
      this.options.thinking = maxThinkingTokens === null
        ? undefined
        : maxThinkingTokens === 0
          ? { type: "disabled" }
          : { type: "enabled", budgetTokens: maxThinkingTokens, ...(this.thinkingDisplay ? { display: this.thinkingDisplay } : {}) };
      this.options.maxThinkingTokens = maxThinkingTokens;
      return;
    }
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("set_session_thinking", { sessionKey: this.sessionKey, thinking });
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    validateFlagSettings(settings);
    if (this.done) throw new PilotDeckError({ code: "conflict", message: "applyFlagSettings requires an open streaming query." });
    // Query initialization submits the first turn.  Allow callers to apply
    // the supported flag subset before that point, so the values are carried
    // in the normal session/turn request instead of forcing an already-active
    // turn and immediately receiving SESSION_BUSY from the Gateway.
    if (!this.initialized) {
      if (Object.prototype.hasOwnProperty.call(settings, "effortLevel")) {
        const effort = settings.effortLevel;
        if (effort === null) {
          this.options.effort = undefined;
        } else {
          // `normalizeThinkingOption` gives explicit thinking/max-token
          // options precedence over effort.  A flag-layer effort is an
          // explicit override, so clear those lower-level query options.
          this.options.thinking = undefined;
          this.options.maxThinkingTokens = undefined;
          this.options.effort = effort as "low" | "medium" | "high";
        }
      }
      if (Object.prototype.hasOwnProperty.call(settings, "permissions")) {
        const permissions = settings.permissions;
        const mode = permissions === null ? null : (permissions as Record<string, unknown>).defaultMode;
        this.options.permissionMode = mode === null || mode === undefined
          ? undefined
          : mode as PilotDeckPermissionMode;
      }
      return;
    }
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("apply_flag_settings", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      settings,
    });
    if (Object.prototype.hasOwnProperty.call(settings, "effortLevel")) {
      const effort = settings.effortLevel;
      if (effort === null) {
        this.options.effort = undefined;
        this.options.thinking = undefined;
      } else {
        this.options.effort = effort as "low" | "medium" | "high";
        this.options.thinking = { type: "enabled", ...(this.thinkingDisplay ? { display: this.thinkingDisplay } : {}) };
      }
    }
    if (Object.prototype.hasOwnProperty.call(settings, "permissions")) {
      const permissions = settings.permissions;
      const mode = permissions === null ? null : (permissions as Record<string, unknown>).defaultMode;
      if (mode === null || mode === undefined) this.options.permissionMode = undefined;
      else this.options.permissionMode = mode as PilotDeckPermissionMode;
    }
  }

  async updateSettings(source: "localSettings", settings: PilotDeckLocalSettingsUpdate): Promise<void> {
    if (source !== "localSettings") {
      throw new PilotDeckError({ code: "validation_error", message: "PilotDeck SDK supports only the localSettings source." });
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new PilotDeckError({ code: "validation_error", message: "updateSettings settings must be an object." });
    }
    // Settings are Gateway-hosted and may be changed before this query's
    // first turn.  Connect without calling initialize(), which would submit
    // that turn and race the configuration reload.
    await this.transport.connect();
    await this.transport.request("update_settings", { source, settings: settings as Record<string, unknown> });
  }

  async initializationResult(): Promise<import("./types.js").PilotDeckInitializationResult> {
    if (this.initialization) return this.initialization;
    await this.initialize();
    const [server, commands, models, agents] = await Promise.all([
      this.transport.request("describe_server", {}),
      this.supportedCommands(),
      this.supportedModels(),
      this.supportedAgents(),
    ]);
    this.initialization = { server: server as PilotDeckServerInfo, commands, models, agents, capabilities: (server as PilotDeckServerInfo).capabilities };
    return this.initialization;
  }

  async reinitialize(): Promise<import("./types.js").PilotDeckInitializationResult> {
    this.initialization = undefined;
    return this.initializationResult();
  }

  async supportedCommands(): Promise<PilotDeckCommand[]> {
    const result = await this.requestOptional("commands_list", { projectKey: this.options.projectKey }, true) as any;
    return [...(result?.pinned ?? []), ...(result?.builtIn ?? []), ...(result?.custom ?? [])];
  }

  async supportedModels(): Promise<PilotDeckModel[]> {
    const result = await this.requestOptional("model_catalog_list", { projectKey: this.options.projectKey }, true) as any;
    return Array.isArray(result?.items) ? result.items : (Array.isArray(result?.models) ? result.models : []);
  }

  async supportedAgents(): Promise<import("./types.js").PilotDeckAgentInfo[]> {
    const result = await this.requestOptional("supported_agents", {}, true) as { agents?: import("./types.js").PilotDeckAgentInfo[] };
    return Array.isArray(result?.agents) ? result.agents : [];
  }

  async mcpServerStatus(): Promise<PilotDeckMcpStatus[]> {
    const result = await this.requestOptional("mcp_server_status", { projectKey: this.options.projectKey, sessionKey: this.sessionKey }, true) as any;
    return Array.isArray(result?.servers) ? result.servers : [];
  }

  async getContextUsage(options: { detail?: "summary" | "full" } = {}): Promise<PilotDeckContextUsage> {
    const detail = options.detail ?? "full";
    if (detail !== "summary" && detail !== "full") throw new PilotDeckError({ code: "validation_error", message: `Unsupported context usage detail: ${String(detail)}` });
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    const result = await this.requestOptional("active_turn_snapshot", { sessionKey: this.sessionKey, includeEvents: true }) as any;
    const event = Array.isArray(result?.events)
      ? [...result.events].reverse().find((item: any) => item?.type === "context_budget")
      : undefined;
    const snapshot = (event ?? this.latestContextUsage) as PilotDeckContextUsage | undefined;
    if (!snapshot) throw unsupported("getContextUsage");
    const { breakdown, ...summary } = snapshot;
    // The Gateway owns this local-tokenizer estimate. Never derive category
    // counts from a provider's aggregate token value, and keep summary mode
    // intentionally compact.
    if (detail === "full" && breakdown && typeof breakdown === "object") {
      return { ...summary, detail, breakdown, breakdownAvailable: true };
    }
    return { ...summary, detail, breakdownAvailable: false };
  }

  async usage(_options?: { skipBehaviors?: boolean }): Promise<import("./types.js").PilotDeckUsage> {
    await this.initialize();
    if (this.serverInfoSnapshot?.capabilities?.includes("usage_snapshot")) {
      const snapshot = await this.transport.request("usage_snapshot", {
        projectKey: this.options.projectKey,
        ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
      }) as { aggregate?: Record<string, unknown>; scope?: "session" | "project" };
      const aggregate = snapshot.aggregate ?? {};
      return {
        ...aggregate,
        scope: snapshot.scope,
        inputTokens: aggregate.totalInputTokens,
        outputTokens: aggregate.totalOutputTokens,
        totalCostUsd: aggregate.totalCost,
        ...(aggregate.costSources ? { costSources: aggregate.costSources } : {}),
      } as import("./types.js").PilotDeckUsage;
    }
    const snapshot = this.sessionKey
      ? await this.requestOptional("active_turn_snapshot", { sessionKey: this.sessionKey, includeEvents: true }) as any
      : undefined;
    const completed = Array.isArray(snapshot?.events)
      ? [...snapshot.events].reverse().find((event: any) => event?.type === "turn_completed" && event?.usage)
      : undefined;
    return (completed?.usage ?? this.latestUsage ?? {}) as import("./types.js").PilotDeckUsage;
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<import("./types.js").PilotDeckUsage> {
    return this.usage(options);
  }

  async modelUsage(): Promise<import("./types.js").PilotDeckModelUsageSnapshot> {
    await this.initialize();
    return await this.requestOptional("model_usage_snapshot", {
      projectKey: this.options.projectKey,
      ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
    }) as import("./types.js").PilotDeckModelUsageSnapshot;
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<import("./types.js").PilotDeckFileRead | null> {
    const result = await this.requestOptional("project_file_read", { projectKey: this.options.projectKey, path, ...options }) as any;
    if (!result || result.content === undefined) return null;
    return { path: String(result.path ?? path), content: String(result.content), encoding: result.encoding };
  }

  async reloadPlugins(): Promise<PilotDeckReloadResult> { return await this.requestOptional("reload_extensions", {}) as PilotDeckReloadResult; }
  async reloadSkills(): Promise<PilotDeckReloadResult> { return await this.requestOptional("reload_extensions", { reloadSkills: true }) as PilotDeckReloadResult; }
  async outputStyles(): Promise<PilotDeckOutputStyle[]> {
    const result = await this.requestOptional("output_styles_list", {
      projectKey: this.options.projectKey,
      ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
    }) as { styles?: PilotDeckOutputStyle[] };
    return result.styles ?? [];
  }
  async setOutputStyle(name: string | null): Promise<PilotDeckOutputStyleSelection> {
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    if (name !== null && !name.trim()) throw new PilotDeckError({ code: "validation_error", message: "Output style name must be non-empty or null." });
    return await this.transport.request("set_output_style", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      name,
    }) as PilotDeckOutputStyleSelection;
  }
  async reloadOutputStyles(): Promise<PilotDeckReloadResult> {
    return await this.requestOptional("reload_output_styles", { projectKey: this.options.projectKey }) as PilotDeckReloadResult;
  }
  async accountInfo(): Promise<import("./types.js").PilotDeckAccountInfo> { throw unsupported("accountInfo"); }
  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<import("./types.js").PilotDeckRewindResult> {
    if (this.options.enableFileCheckpointing !== true) {
      return { canRewind: false, error: "File checkpointing was not enabled for this query." };
    }
    await this.initialize();
    if (!this.done) throw new PilotDeckError({ code: "conflict", message: "rewindFiles requires the active turn to finish first." });
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    return await this.transport.request("rewind_files", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      userMessageId,
      dryRun: options?.dryRun,
    }) as import("./types.js").PilotDeckRewindResult;
  }
  async seedReadState(path: string, mtime: number): Promise<void> {
    if (!path.trim()) throw new PilotDeckError({ code: "validation_error", message: "path is required." });
    if (!Number.isInteger(mtime) || mtime < 0) {
      throw new PilotDeckError({ code: "validation_error", message: "mtime must be a non-negative integer in milliseconds." });
    }
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    if (!this.done) throw new PilotDeckError({ code: "conflict", message: "seedReadState requires the active turn to finish first." });
    await this.transport.request("seed_read_state", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      channelKey: this.options.channelKey ?? "api_server",
      workspaceCwd: this.options.cwd,
      path,
      mtime,
      ...(sdkSessionConfig(this.options) ? { sdkSessionConfig: sdkSessionConfig(this.options) } : {}),
    });
  }
  async reconnectMcpServer(serverName: string): Promise<void> {
    if (!serverName.trim()) throw new PilotDeckError({ code: "validation_error", message: "serverName is required." });
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("mcp_server_reconnect", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      serverName,
    });
  }
  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    if (!serverName.trim()) throw new PilotDeckError({ code: "validation_error", message: "serverName is required." });
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("mcp_server_toggle", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      serverName,
      enabled,
    });
  }
  async setMcpServers(servers: Record<string, PilotDeckMcpServerConfig>): Promise<PilotDeckMcpSetResult> {
    validateOptions({ ...this.options, mcpServers: servers });
    // During query initialization `sessionKey` is established before the
    // option-owned MCP collection is applied. Do not await initialize() from
    // that path: doing so would await this very initialization promise.
    if (!this.sessionKey) await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    let newlyStarted: PilotDeckMcpServer[] = [];
    try {
      const prepared = await prepareGatewayMcpServers(servers, this.options.gatewayUrl);
      newlyStarted = prepared.newlyStarted;
      if (this.initializationTimeoutError) throw this.initializationTimeoutError;
      const result = await this.transport.request("set_mcp_servers", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
        servers: prepared.servers,
      }) as PilotDeckMcpSetResult & { errors?: Array<{ name: string; error: string }> };
      if (Array.isArray(result.errors) && result.errors.length > 0 && this.options.strictMcpConfig === true) {
        throw new PilotDeckError({
          code: "validation_error",
          message: `Gateway rejected MCP server configuration: ${result.errors.map((error) => `${error.name}: ${error.error}`).join("; ")}`,
          details: result.errors,
        });
      }
      this.options.mcpServers = { ...servers };
      return result;
    } catch (error) {
      // A strict configuration is all-or-nothing. Close only endpoints this
      // call brought up; callers that supplied an already-running endpoint
      // retain ownership of it.
      if (this.options.strictMcpConfig === true || this.initializationTimeoutError) {
        await Promise.allSettled(newlyStarted.map((server) => server.close()));
      }
      throw error;
    }
  }
  async streamInput(stream: AsyncIterable<PilotDeckUserMessage>): Promise<void> {
    for await (const message of stream) {
      await this.steer({ type: "text", text: userMessageText(message) });
    }
  }
  async stopTask(taskId: string): Promise<void> {
    if (!taskId.trim()) throw new PilotDeckError({ code: "validation_error", message: "taskId is required." });
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    await this.transport.request("background_task_stop", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      taskId,
    });
  }
  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    await this.initialize();
    if (!this.sessionKey) throw new PilotDeckError({ code: "validation_error", message: "Query session is not initialized." });
    const result = await this.transport.request("background_tasks", {
      sessionKey: this.sessionKey,
      projectKey: this.options.projectKey,
      ...(toolUseId ? { taskId: toolUseId } : {}),
    }) as { backgrounded?: boolean };
    return result.backgrounded === true;
  }

  close(): void {
    this.done = true;
    this.options.abortController?.signal.removeEventListener("abort", this.abortListener);
    this.abortController.abort();
    void this.flushMirror();
    void this.closeHostedHooks();
    this.transport.close();
  }

  private async startHostedHooks(): Promise<HostedHookConfig | undefined> {
    if (!this.options.hooks || Object.keys(this.options.hooks).length === 0) return undefined;
    const server = this.hostedHookServer ??= new HostedHookServer(this.options.hooks);
    const endpoint = await server.start(this.options.hookServer);
    if (isLoopbackHttpUrl(endpoint.url) && !isLoopbackGatewayUrl(this.options.gatewayUrl)) {
      await server.close();
      this.hostedHookServer = undefined;
      throw new PilotDeckError({
        code: "unsupported_capability",
        message: "SDK hooks are bound to loopback but the configured Gateway is remote. Configure hookServer.publicUrl with an endpoint reachable by that Gateway.",
      });
    }
    return endpoint;
  }

  private async closeHostedHooks(): Promise<void> {
    const server = this.hostedHookServer;
    this.hostedHookServer = undefined;
    await server?.close();
  }

  /** The Gateway remains authoritative until a terminal event makes deletion safe. */
  private async deleteEphemeralSession(): Promise<void> {
    if (this.options.persistSession !== false || this.ephemeralSessionDeleted || !this.sessionKey) return;
    this.ephemeralSessionDeleted = true;
    try {
      await this.transport.request("delete_session", {
        sessionKey: this.sessionKey,
        projectKey: this.options.projectKey,
      });
    } catch (cause) {
      this.ephemeralSessionDeleted = false;
      throw mapError(cause);
    }
  }

  private async handlePermission(message: PilotDeckMessage): Promise<void> {
    if (!this.permissionHandler || !this.sessionKey) return;
    const requestId = String(message.requestId);
    const payload = asRecord(message.payload ?? message.input);
    const context = {
      requestId,
      sessionId: this.sessionKey,
      runId: this.runId,
      signal: this.abortController.signal,
      ...(Array.isArray(payload.suggestions) ? { suggestions: payload.suggestions } : {}),
      ...(typeof payload.blockedPath === "string" ? { blockedPath: payload.blockedPath } : {}),
      ...(typeof payload.decisionReason === "string" ? { decisionReason: payload.decisionReason } : {}),
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(typeof payload.displayName === "string" ? { displayName: payload.displayName } : {}),
      ...(typeof payload.description === "string" ? { description: payload.description } : {}),
      ...(typeof payload.toolUseID === "string" ? { toolUseID: payload.toolUseID } : {}),
      ...(typeof payload.agentID === "string" ? { agentID: payload.agentID } : {}),
    } satisfies PermissionRequestContext;
    let decision: Awaited<ReturnType<CanUseTool>>;
    try {
      decision = await this.permissionHandler(String(message.toolName), payload, context);
    } catch (cause) {
      await this.transport.request("permission_decide", { sessionKey: this.sessionKey, requestId, decision: "deny", remember: false, reason: "SDK permission callback failed." });
      throw new PilotDeckError({ code: "permission_callback_error", message: "The SDK permission callback failed; the tool request was denied.", cause });
    }
    await this.transport.request("permission_decide", { sessionKey: this.sessionKey, requestId, decision: decision.behavior === "allow" ? "allow" : "deny", remember: decision.remember, reason: decision.reason ?? decision.message });
  }

  private async handleElicitation(message: PilotDeckMessage): Promise<void> {
    if ((!this.options.onElicitation && !this.options.onUserDialog) || !this.sessionKey) return;
    const requestId = String(message.requestId);
    const userDialogHandler = this.options.onUserDialog;
    const useUserDialog = userDialogHandler && supportsUserDialogKind(this.options, "elicitation");
    if (!this.options.onElicitation && !useUserDialog) {
      await this.transport.request("elicitation_respond", {
        sessionKey: this.sessionKey,
        requestId,
        answer: { type: "cancelled", reason: "SDK onUserDialog does not support elicitation." },
      });
      return;
    }
    let answer: { type: "answered"; answers: Record<string, string | string[]>; annotations?: Record<string, { preview?: string; notes?: string }> } | { type: "cancelled"; reason: string };
    try {
      if (useUserDialog) {
        const result = await userDialogHandler({
          requestId,
          dialogKind: "elicitation",
          payload: {
            sessionId: this.sessionKey,
            runId: this.runId,
            ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
            ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
            ...(message.previewFormat === "html" || message.previewFormat === "markdown"
              ? { previewFormat: message.previewFormat }
              : {}),
            questions: Array.isArray(message.questions) ? message.questions : [],
            metadata: asRecord(message.metadata),
          },
        }, { signal: this.abortController.signal });
        answer = result.behavior === "answered"
          ? normalizeUserDialogElicitationAnswer(result.value)
          : { type: "cancelled", reason: "SDK user dialog callback cancelled the elicitation." };
      } else {
        const result = await this.options.onElicitation!({
          requestId,
          sessionId: this.sessionKey,
          runId: this.runId,
          questions: Array.isArray(message.questions) ? message.questions : [],
          metadata: asRecord(message.metadata),
          ...(typeof message.mode === "string" ? { mode: message.mode } : {}),
          ...(typeof message.message === "string" ? { message: message.message } : {}),
          ...(message.requestedSchema !== undefined ? { requestedSchema: message.requestedSchema } : {}),
        }, { signal: this.abortController.signal });
        answer = result.action === "accept"
          ? normalizeUserDialogElicitationAnswer(result.content)
          : { type: "cancelled", reason: result.action };
      }
    } catch (cause) {
      await this.transport.request("elicitation_respond", { sessionKey: this.sessionKey, requestId, answer: { type: "cancelled", reason: "SDK elicitation callback failed." } });
      throw new PilotDeckError({ code: "elicitation_callback_error", message: "The SDK elicitation callback failed; the request was cancelled.", cause });
    }
    const response = await this.transport.request("elicitation_respond", {
      sessionKey: this.sessionKey,
      requestId,
      answer,
    }) as { delivered?: boolean };
    if (response.delivered === false) {
      throw new PilotDeckError({ code: "conflict", message: `Elicitation ${requestId} is no longer pending.` });
    }
  }

  private async handleUserDialog(message: PilotDeckMessage): Promise<void> {
    if (!this.options.onUserDialog || !this.sessionKey) return;
    const requestId = String(message.requestId);
    try {
      const common = {
        sessionId: this.sessionKey,
        ...(typeof message.runId === "string" ? { runId: message.runId } : {}),
        toolCallId: String(message.toolCallId),
        toolName: String(message.toolName),
        prompt: String(message.prompt),
      };
      let request: PilotDeckUserDialogRequest;
      if (message.dialogKind === "input") {
        request = {
          requestId,
          dialogKind: "input",
          payload: {
            ...common,
            ...(typeof message.placeholder === "string" ? { placeholder: message.placeholder } : {}),
            ...(message.allowEmpty === true ? { allowEmpty: true } : {}),
          },
        };
      } else if (message.dialogKind === "select") {
        const choices = parseUserDialogChoices(message.choices);
        const defaultValue = typeof message.defaultValue === "string" ? message.defaultValue : undefined;
        if (defaultValue !== undefined && !choices.some((choice) => choice.value === defaultValue)) {
          throw new PilotDeckError({ code: "validation_error", message: "Gateway select dialog defaultValue does not exist in choices." });
        }
        request = {
          requestId,
          dialogKind: "select",
          payload: { ...common, choices, ...(defaultValue !== undefined ? { defaultValue } : {}) },
        };
      } else if (message.dialogKind === "confirm") {
        if (message.defaultValue !== undefined && typeof message.defaultValue !== "boolean") {
          throw new PilotDeckError({ code: "validation_error", message: "Gateway confirm dialog defaultValue must be a boolean." });
        }
        request = {
          requestId,
          dialogKind: "confirm",
          payload: {
            ...common,
            ...(typeof message.confirmLabel === "string" ? { confirmLabel: message.confirmLabel } : {}),
            ...(typeof message.cancelLabel === "string" ? { cancelLabel: message.cancelLabel } : {}),
            ...(typeof message.defaultValue === "boolean" ? { defaultValue: message.defaultValue } : {}),
          },
        };
      } else if (message.dialogKind === "form") {
        request = {
          requestId,
          dialogKind: "form",
          payload: { ...common, schema: parseUserDialogFormSchema(message.schema) },
        };
      } else {
        throw new PilotDeckError({ code: "unsupported_capability", message: "Gateway emitted an unsupported user dialog kind." });
      }
      const result = await this.options.onUserDialog(request, { signal: this.abortController.signal });
      let answerValue: unknown;
      if (result.behavior === "answered") {
        if (request.dialogKind === "confirm") {
          if (typeof result.value !== "boolean") {
            throw new PilotDeckError({ code: "validation_error", message: "An answered confirm dialog must return value as a boolean." });
          }
        } else if (request.dialogKind === "form") {
          if (!isPlainRecord(result.value)) {
            throw new PilotDeckError({ code: "validation_error", message: "An answered form dialog must return values as an object." });
          }
        } else {
          if (typeof result.value !== "string") {
            throw new PilotDeckError({ code: "validation_error", message: `An answered ${request.dialogKind} dialog must return value as a string.` });
          }
          if (request.dialogKind === "select" && !request.payload.choices.some((choice) => choice.value === result.value)) {
            throw new PilotDeckError({ code: "validation_error", message: "An answered select dialog must return one of the declared choice values." });
          }
        }
        answerValue = result.value;
      }
      const response = await this.transport.request("user_dialog_respond", {
        sessionKey: this.sessionKey,
        ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
        requestId,
        result: result.behavior === "answered"
          ? { behavior: "answered", value: answerValue! }
          : { behavior: "cancelled", ...(result.reason ? { reason: result.reason } : {}) },
      }) as { delivered?: boolean };
      if (response.delivered === false) {
        throw new PilotDeckError({ code: "conflict", message: `User dialog ${requestId} is no longer pending.` });
      }
    } catch (cause) {
      if (cause instanceof PilotDeckError && cause.code === "conflict") throw cause;
      await this.transport.request("user_dialog_respond", {
        sessionKey: this.sessionKey,
        ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
        requestId,
        result: { behavior: "cancelled", reason: "SDK user dialog callback failed." },
      }).catch(() => undefined);
      throw new PilotDeckError({
        code: "user_dialog_callback_error",
        message: "The SDK user dialog callback failed; the dialog was cancelled.",
        cause,
      });
    }
  }

  private async requestOptional(method: string, params: unknown, tolerateUnavailable = false): Promise<unknown> {
    try { await this.initialize(); return await this.transport.request(method, params); }
    catch (error) {
      const mapped = mapError(error);
      if (tolerateUnavailable && mapped.code === "unsupported_capability") return undefined;
      throw mapped;
    }
  }

  private async resolveModelOverride(model: string): Promise<{ mode: "model"; provider: string; model: string }> {
    if (!this.options.projectKey) throw new PilotDeckError({ code: "validation_error", message: "projectKey is required when options.model is set." });
    const result = await this.transport.request("model_catalog_list", { projectKey: this.options.projectKey }) as { items?: Array<{ id?: string; provider?: string; model?: string; available?: boolean }> };
    const requested = String(model);
    const matches = (result.items ?? []).filter((candidate) => candidate.available !== false && (
      candidate.id === requested || `${candidate.provider}/${candidate.model}` === requested || candidate.model === requested
    ));
    if (matches.length !== 1 || !matches[0]?.provider || !matches[0]?.model) {
      throw new PilotDeckError({ code: "validation_error", message: `Model is not uniquely resolvable: ${requested}` });
    }
    return { mode: "model", provider: matches[0].provider, model: matches[0].model };
  }

  private async mirrorEvent(message: PilotDeckMessage): Promise<void> {
    const store = this.options.sessionStore;
    const projectKey = this.options.projectKey;
    const sessionId = this.sessionKey;
    if (!store || !projectKey || !sessionId) return;
    const sequence = typeof message.sequence === "number" ? message.sequence : 0;
    const entry = {
        type: "sdk_event",
        uuid: `${sessionId}:${message.runId ?? "run"}:${sequence}`,
        timestamp: typeof message.timestamp === "string" ? message.timestamp : new Date().toISOString(),
        event: message,
    };
    this.mirrorQueue.push(entry);
    if (this.options.sessionStoreFlush === "batched") {
      if (!this.mirrorTimer) this.mirrorTimer = setTimeout(() => { this.mirrorTimer = undefined; void this.flushMirror(); }, 100);
      return;
    }
    await this.flushMirror();
  }

  private async flushMirror(): Promise<void> {
    const store = this.options.sessionStore;
    const projectKey = this.options.projectKey;
    const sessionId = this.sessionKey;
    if (!store || !projectKey || !sessionId || this.mirrorQueue.length === 0) return;
    if (this.mirrorTimer) { clearTimeout(this.mirrorTimer); this.mirrorTimer = undefined; }
    const batch = this.mirrorQueue.splice(0);
    this.mirrorFlush = this.mirrorFlush.then(async () => {
      try { await store.append({ projectKey, sessionId }, batch); }
      catch { /* best-effort mirror; Gateway transcript remains authoritative */ }
    });
    await this.mirrorFlush;
  }
}

function unsupported(name: string): PilotDeckError {
  return new PilotDeckError({ code: "unsupported_capability", message: `${name} is not exposed by the current Gateway protocol.` });
}

function validateFlagSettings(settings: Record<string, unknown>): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new PilotDeckError({ code: "validation_error", message: "applyFlagSettings settings must be an object." });
  }
  for (const [key, value] of Object.entries(settings)) {
    if (key === "effortLevel") {
      if (value !== null && value !== "low" && value !== "medium" && value !== "high") {
        throw new PilotDeckError({ code: "validation_error", message: "effortLevel must be low, medium, high, or null." });
      }
      continue;
    }
    if (key === "permissions") {
      if (value === null) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new PilotDeckError({ code: "validation_error", message: "permissions must be an object or null." });
      }
      for (const [permissionKey, permissionValue] of Object.entries(value as Record<string, unknown>)) {
        if (permissionKey !== "defaultMode") {
          throw unsupported(`applyFlagSettings permissions.${permissionKey}`);
        }
        if (permissionValue !== null
          && permissionValue !== "default"
          && permissionValue !== "plan"
          && permissionValue !== "bypassPermissions") {
          throw unsupported(`applyFlagSettings permissions.defaultMode=${String(permissionValue)}`);
        }
      }
      continue;
    }
    throw unsupported(`applyFlagSettings ${key}`);
  }
}

function normalizeThinkingOption(
  options: Pick<PilotDeckOptions, "thinking" | "maxThinkingTokens" | "effort">,
): { enabled: boolean; mode: "default" | "off" | "low" | "medium" | "high" | "xhigh" | "max"; budgetTokens?: number } | null | undefined {
  const thinking = options.thinking;
  if (thinking?.type === "disabled") return { enabled: false, mode: "off" };
  if (thinking?.type === "adaptive") return { enabled: true, mode: "default" };
  if (thinking?.type === "enabled") {
    return {
      enabled: true,
      mode: "medium",
      ...(thinking.budgetTokens !== undefined ? { budgetTokens: thinking.budgetTokens } : {}),
    };
  }
  if (options.maxThinkingTokens === null) return null;
  if (options.maxThinkingTokens === 0) return { enabled: false, mode: "off" };
  if (options.maxThinkingTokens !== undefined) {
    return { enabled: true, mode: "medium", budgetTokens: options.maxThinkingTokens };
  }
  if (options.effort !== undefined) return { enabled: true, mode: options.effort };
  return undefined;
}

function sdkSessionConfig(
  options: Pick<PilotDeckOptions, "systemPrompt" | "appendSystemPrompt" | "outputStyle" | "planModeInstructions" | "toolAliases" | "deferredTools" | "additionalDirectories" | "outputFormat" | "agents" | "includeHookEvents" | "agentProgressSummaries" | "forwardSubagentText" | "promptSuggestions" | "supportedDialogKinds" | "permissionMode" | "skills" | "plugins" | "persistSession" | "fallbackModel" | "taskBudget" | "managedSettings" | "settings" | "settingSources" | "sandbox">,
  hooks?: HostedHookConfig,
): {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  outputStyle?: string;
  planModeInstructions?: string;
  permissionMode?: "acceptEdits" | "dontAsk";
  toolAliases?: Record<string, string>;
  deferredTools?: Array<{ name: string; searchHint?: string }>;
  additionalWorkingDirectories?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  agents?: Record<string, GatewayAgentDefinition>;
  skills?: string[] | "all";
  plugins?: Array<{ type: "local"; path: string }>;
  hooks?: HostedHookConfig;
  includeHookEvents?: boolean;
  agentProgressSummaries?: boolean;
  forwardSubagentText?: boolean;
  promptSuggestions?: boolean;
  userDialogKinds?: Array<"input" | "select" | "confirm" | "form">;
  sandbox?: { filesystem?: "read_only" | "deny"; network?: "deny"; process?: "deny" };
  persistSession?: false;
  fallbackModel?: string;
  taskBudget?: { total: number; scope?: "session" | "project"; projectRetentionMs?: number };
  managedPermissions?: { deny: string[]; ask: string[]; defaultMode?: "plan"; canPrompt?: false };
  managedTools?: { allow: string[]; deny: string[] };
  managedModels?: { allow: string[]; deny: string[] };
  settings?: { agent?: { model?: string | null; fallbackModel?: string | null; maxContextTokens?: number; maxOutputTokens?: number; thinking?: { enabled: boolean; budgetTokens?: number }; subagents?: { default?: string | null; timeoutMs?: number; maxDepth?: number } } };
  settingSources?: Array<"managed" | "user" | "project" | "local">;
} | undefined {
  const systemPrompt = options.systemPrompt === undefined ? undefined : normalizeSystemPrompt(options.systemPrompt);
  const appendSystemPrompt = options.appendSystemPrompt;
  const outputStyle = options.outputStyle;
  const planModeInstructions = options.planModeInstructions;
  const toolAliases = options.toolAliases && Object.keys(options.toolAliases).length > 0
    ? { ...options.toolAliases }
    : undefined;
  const deferredTools = options.deferredTools?.map((tool) => ({
    name: tool.name.trim(),
    ...(tool.searchHint ? { searchHint: tool.searchHint.trim() } : {}),
  }));
  const additionalWorkingDirectories = options.additionalDirectories?.length
    ? [...options.additionalDirectories]
    : undefined;
  const outputFormat = options.outputFormat
    ? { type: "json_schema" as const, schema: structuredClone(options.outputFormat.schema) }
    : undefined;
  const agents = options.agents && Object.keys(options.agents).length > 0
    ? serializeAgentDefinitions(options.agents)
    : undefined;
  const skills = options.skills === "all"
    ? "all"
    : options.skills
      ? [...options.skills]
      : undefined;
  const plugins = options.plugins?.map((plugin) => ({ type: "local" as const, path: plugin.path }));
  const permissionMode = options.permissionMode === "acceptEdits" || options.permissionMode === "dontAsk"
    ? options.permissionMode
    : undefined;
  const persistSession = options.persistSession === false ? false : undefined;
  const fallbackModel = options.fallbackModel?.trim() || undefined;
  const userDialogKinds = options.supportedDialogKinds
    ?.filter((kind): kind is "input" | "select" | "confirm" | "form" => kind !== "elicitation");
  const sandbox = normalizeSandbox(options.sandbox);
  const taskBudget = options.taskBudget
    ? {
        total: options.taskBudget.total,
        ...(options.taskBudget.scope === "project" ? { scope: "project" as const } : {}),
        ...(options.taskBudget.projectRetentionMs !== undefined
          ? { projectRetentionMs: options.taskBudget.projectRetentionMs }
          : {}),
      }
    : undefined;
  const managedSettings = normalizeManagedSettings(options.managedSettings);
  const managedPermissions = managedSettings?.permissions;
  const managedTools = managedSettings?.tools;
  const managedModels = managedSettings?.models;
  const settings = normalizeSessionSettings(options.settings);
  const settingSources = normalizeSettingSources(options.settingSources);
  if (systemPrompt === undefined && appendSystemPrompt === undefined && outputStyle === undefined && planModeInstructions === undefined && !permissionMode && !toolAliases && !deferredTools?.length && !additionalWorkingDirectories && !outputFormat && !agents && skills === undefined && !plugins && !hooks && options.includeHookEvents !== true && options.agentProgressSummaries === undefined && options.forwardSubagentText === undefined && options.promptSuggestions === undefined && !userDialogKinds?.length && !sandbox && persistSession === undefined && fallbackModel === undefined && taskBudget === undefined && !managedPermissions && !managedTools && !managedModels && !settings && !settingSources) return undefined;
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    ...(outputStyle !== undefined ? { outputStyle } : {}),
    ...(planModeInstructions !== undefined ? { planModeInstructions } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(toolAliases ? { toolAliases } : {}),
    ...(deferredTools?.length ? { deferredTools } : {}),
    ...(additionalWorkingDirectories ? { additionalWorkingDirectories } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(agents ? { agents } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(plugins ? { plugins } : {}),
    ...(hooks ? { hooks } : {}),
    ...(options.includeHookEvents === true ? { includeHookEvents: true } : {}),
    ...(options.agentProgressSummaries !== undefined
      ? { agentProgressSummaries: options.agentProgressSummaries }
      : {}),
    ...(options.forwardSubagentText !== undefined
      ? { forwardSubagentText: options.forwardSubagentText }
      : {}),
    ...(options.promptSuggestions !== undefined ? { promptSuggestions: options.promptSuggestions } : {}),
    ...(userDialogKinds?.length ? { userDialogKinds } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(persistSession === false ? { persistSession: false } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(taskBudget ? { taskBudget } : {}),
    ...(managedPermissions ? { managedPermissions } : {}),
    ...(managedTools ? { managedTools } : {}),
    ...(managedModels ? { managedModels } : {}),
    ...(settings ? { settings } : {}),
    ...(settingSources ? { settingSources } : {}),
  };
}

function normalizeSessionSettings(
  value: PilotDeckOptions["settings"],
): { agent?: { model?: string | null; fallbackModel?: string | null; maxContextTokens?: number; maxOutputTokens?: number; thinking?: { enabled: boolean; budgetTokens?: number }; subagents?: { default?: string | null; timeoutMs?: number; maxDepth?: number } } } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "settings must be an object." });
  }
  for (const key of Object.keys(value)) {
    if (key !== "agent") throw unsupported(`settings.${key}`);
  }
  if (value.agent === undefined) return undefined;
  if (!value.agent || typeof value.agent !== "object" || Array.isArray(value.agent)) {
    throw new PilotDeckError({ code: "validation_error", message: "settings.agent must be an object." });
  }
  const agent = value.agent;
  for (const key of Object.keys(agent)) {
    if (key !== "model" && key !== "fallbackModel" && key !== "maxContextTokens" && key !== "maxOutputTokens" && key !== "thinking" && key !== "subagents") {
      throw unsupported(`settings.agent.${key}`);
    }
  }
  const normalized: NonNullable<NonNullable<PilotDeckOptions["settings"]>["agent"]> = {};
  if (agent.model !== undefined) {
    if (agent.model !== null && (typeof agent.model !== "string" || !agent.model.trim())) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.model must be a non-empty model id or null." });
    }
    normalized.model = agent.model === null ? null : agent.model.trim();
  }
  if (agent.fallbackModel !== undefined) {
    if (agent.fallbackModel !== null && (typeof agent.fallbackModel !== "string" || !agent.fallbackModel.trim())) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.fallbackModel must be a non-empty model id or null." });
    }
    normalized.fallbackModel = agent.fallbackModel === null ? null : agent.fallbackModel.trim();
  }
  for (const key of ["maxContextTokens", "maxOutputTokens"] as const) {
    const setting = agent[key];
    if (setting === undefined) continue;
    if (!Number.isInteger(setting) || setting <= 0) {
      throw new PilotDeckError({ code: "validation_error", message: `settings.agent.${key} must be a positive integer.` });
    }
    normalized[key] = setting;
  }
  if (agent.thinking !== undefined) {
    if (!agent.thinking || typeof agent.thinking !== "object" || Array.isArray(agent.thinking)
      || typeof agent.thinking.enabled !== "boolean") {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.thinking must include a boolean enabled field." });
    }
    for (const key of Object.keys(agent.thinking)) {
      if (key !== "enabled" && key !== "budgetTokens") throw unsupported(`settings.agent.thinking.${key}`);
    }
    if (agent.thinking.budgetTokens !== undefined
      && (!Number.isInteger(agent.thinking.budgetTokens) || agent.thinking.budgetTokens < 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.thinking.budgetTokens must be a non-negative integer." });
    }
    normalized.thinking = {
      enabled: agent.thinking.enabled,
      ...(agent.thinking.budgetTokens !== undefined ? { budgetTokens: agent.thinking.budgetTokens } : {}),
    };
  }
  if (agent.subagents !== undefined) {
    if (!agent.subagents || typeof agent.subagents !== "object" || Array.isArray(agent.subagents)) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.subagents must be an object." });
    }
    if (Object.keys(agent.subagents).some((key) => key !== "default" && key !== "timeoutMs" && key !== "maxDepth")) {
      throw unsupported("settings.agent.subagents");
    }
    const defaultModel = agent.subagents.default;
    if (defaultModel !== undefined && defaultModel !== null
      && (typeof defaultModel !== "string" || !defaultModel.trim())) {
      throw new PilotDeckError({
        code: "validation_error",
        message: "settings.agent.subagents.default must be a non-empty model id, inherit, or null.",
      });
    }
    const timeoutMs = agent.subagents.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.subagents.timeoutMs must be a positive integer." });
    }
    const maxDepth = agent.subagents.maxDepth;
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "settings.agent.subagents.maxDepth must be a non-negative safe integer." });
    }
    if (defaultModel !== undefined || timeoutMs !== undefined || maxDepth !== undefined) {
      normalized.subagents = {
        ...(defaultModel !== undefined
          ? { default: defaultModel === null || defaultModel.trim() === "inherit" ? null : defaultModel.trim() }
          : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      };
    }
  }
  return Object.keys(normalized).length > 0 ? { agent: normalized } : undefined;
}

function normalizeSettingSources(
  value: PilotDeckOptions["settingSources"],
): Array<"managed" | "user" | "project" | "local"> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new PilotDeckError({ code: "validation_error", message: "settingSources must be a non-empty array." });
  }
  if (value.some((source) => source !== "managed" && source !== "user" && source !== "project" && source !== "local")) {
    throw unsupported("settingSources");
  }
  if (new Set(value).size !== value.length) {
    throw new PilotDeckError({ code: "validation_error", message: "settingSources cannot contain duplicates." });
  }
  return [...value];
}

function normalizeManagedSettings(value: PilotDeckManagedSettings | undefined): {
  permissions?: { deny: string[]; ask: string[]; defaultMode?: "plan"; canPrompt?: false };
  tools?: { allow: string[]; deny: string[] };
  models?: { allow: string[]; deny: string[] };
} | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "managedSettings must be an object." });
  }
  for (const key of Object.keys(value)) {
    if (key !== "permissions" && key !== "tools" && key !== "models") {
      throw unsupported(`managedSettings.${key}`);
    }
  }
  const tools = normalizeManagedTools(value.tools);
  const models = normalizeManagedModels(value.models);
  if (value.permissions === undefined) {
    return tools || models
      ? { ...(tools ? { tools } : {}), ...(models ? { models } : {}) }
      : undefined;
  }
  const permissions = value.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new PilotDeckError({ code: "validation_error", message: "managedSettings.permissions must be an object." });
  }
  for (const key of Object.keys(permissions)) {
    if (key !== "deny" && key !== "ask" && key !== "defaultMode" && key !== "canPrompt") {
      throw unsupported(`managedSettings.permissions.${key}`);
    }
  }
  const normalizeEntries = (entries: string[] | undefined, label: "deny" | "ask"): string[] => {
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.permissions.${label} must be an array of non-empty strings.` });
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.permissions.${label} cannot contain duplicate entries.` });
    }
    return normalized;
  };
  if (permissions.defaultMode !== undefined && permissions.defaultMode !== "plan") {
    throw unsupported("managedSettings.permissions.defaultMode");
  }
  if (permissions.canPrompt !== undefined && permissions.canPrompt !== false) {
    throw unsupported("managedSettings.permissions.canPrompt");
  }
  const deny = normalizeEntries(permissions.deny, "deny");
  const ask = normalizeEntries(permissions.ask, "ask");
  if (deny.length === 0 && ask.length === 0 && permissions.defaultMode === undefined && permissions.canPrompt !== false) {
    return tools || models
      ? { ...(tools ? { tools } : {}), ...(models ? { models } : {}) }
      : undefined;
  }
  return {
    permissions: {
      deny,
      ask,
      ...(permissions.defaultMode === "plan" ? { defaultMode: "plan" as const } : {}),
      ...(permissions.canPrompt === false ? { canPrompt: false as const } : {}),
    },
    ...(tools ? { tools } : {}),
    ...(models ? { models } : {}),
  };
}

function normalizeManagedTools(
  value: PilotDeckManagedSettings["tools"],
): { allow: string[]; deny: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "managedSettings.tools must be an object." });
  }
  for (const key of Object.keys(value)) {
    if (key !== "allow" && key !== "deny") throw unsupported(`managedSettings.tools.${key}`);
  }
  const normalizeEntries = (entries: string[] | undefined, label: "allow" | "deny"): string[] => {
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isManagedToolSelector(entry.trim()))) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.tools.${label} entries must be an exact tool name, prefix*, or * selector.` });
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.tools.${label} cannot contain duplicate entries.` });
    }
    return normalized;
  };
  const allow = normalizeEntries(value.allow, "allow");
  const deny = normalizeEntries(value.deny, "deny");
  return allow.length > 0 || deny.length > 0 ? { allow, deny } : undefined;
}

function isManagedToolSelector(value: string): boolean {
  return value === "*" || /^[A-Za-z0-9][A-Za-z0-9_.:-]*\*?$/.test(value);
}

function normalizeManagedModels(
  value: PilotDeckManagedSettings["models"],
): { allow: string[]; deny: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "managedSettings.models must be an object." });
  }
  for (const key of Object.keys(value)) {
    if (key !== "allow" && key !== "deny") throw unsupported(`managedSettings.models.${key}`);
  }
  const normalizeEntries = (entries: string[] | undefined, label: "allow" | "deny"): string[] => {
    if (entries === undefined) return [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !isManagedModelSelector(entry.trim()))) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.models.${label} entries must be *, provider/*, or provider/model selectors.` });
    }
    const normalized = entries.map((entry) => entry.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new PilotDeckError({ code: "validation_error", message: `managedSettings.models.${label} cannot contain duplicate entries.` });
    }
    return normalized;
  };
  const allow = normalizeEntries(value.allow, "allow");
  const deny = normalizeEntries(value.deny, "deny");
  return allow.length > 0 || deny.length > 0 ? { allow, deny } : undefined;
}

function isManagedModelSelector(value: string): boolean {
  return value === "*" || /^[^/\s]+\/(?:[^/\s]+|\*)$/.test(value);
}

function normalizeSandbox(
  value: import("./types.js").PilotDeckSandboxSettings | undefined,
): {
  type?: "tool_policy" | "host";
  profile?: string;
  toolIsolation?: "strict";
  filesystem?: "read_only" | "deny";
  network?: "deny";
  process?: "deny";
} | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "sandbox must be a tool_policy or host profile object." });
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "profile" && key !== "toolIsolation" && key !== "filesystem" && key !== "network" && key !== "process") {
      throw unsupported(`sandbox.${key}`);
    }
  }
  if (value.type !== undefined && value.type !== "tool_policy" && value.type !== "host") {
    throw unsupported(`sandbox.type=${String(value.type)}`);
  }
  if (value.type === "host") {
    if (typeof value.profile !== "string" || !value.profile.trim()) {
      throw new PilotDeckError({ code: "validation_error", message: "sandbox.profile must be a non-empty host profile name." });
    }
    if (value.toolIsolation !== undefined && value.toolIsolation !== "strict") {
      throw unsupported(`sandbox.toolIsolation=${String(value.toolIsolation)}`);
    }
  } else {
    if ("profile" in value && value.profile !== undefined) throw unsupported("sandbox.profile");
    if ("toolIsolation" in value && value.toolIsolation !== undefined) throw unsupported("sandbox.toolIsolation");
  }
  if (value.filesystem !== undefined && value.filesystem !== "read_only" && value.filesystem !== "deny") {
    throw unsupported(`sandbox.filesystem=${String(value.filesystem)}`);
  }
  if (value.network !== undefined && value.network !== "deny") throw unsupported(`sandbox.network=${String(value.network)}`);
  if (value.process !== undefined && value.process !== "deny") throw unsupported(`sandbox.process=${String(value.process)}`);
  if (value.filesystem === undefined && value.network === undefined && value.process === undefined) {
    if (value.type !== "host") {
      throw new PilotDeckError({ code: "validation_error", message: "tool_policy sandbox must declare at least one restriction." });
    }
  }
  const restrictions = {
    ...(value.filesystem === "read_only" || value.filesystem === "deny" ? { filesystem: value.filesystem } : {}),
    ...(value.network === "deny" ? { network: "deny" as const } : {}),
    ...(value.process === "deny" ? { process: "deny" as const } : {}),
  };
  return value.type === "host"
    ? {
        type: "host",
        profile: value.profile.trim(),
        ...(value.toolIsolation === "strict" ? { toolIsolation: "strict" as const } : {}),
        ...restrictions,
      }
    : restrictions;
}

function serializeAgentDefinitions(agents: Record<string, import("./types.js").PilotDeckAgentDefinition>): Record<string, GatewayAgentDefinition> {
  return Object.fromEntries(Object.entries(agents).map(([name, agent]) => [
    name,
    {
      ...structuredClone(withoutMcpServers(agent)),
      ...(agent.mcpServers !== undefined
        ? { mcpServers: serializeAgentMcpServers(name, agent.mcpServers) }
        : {}),
    },
  ]));
}

function validateAgentMcpServers(
  agentName: string,
  value: NonNullable<import("./types.js").PilotDeckAgentDefinition["mcpServers"]>,
): void {
  const specs = Array.isArray(value) ? value : [value];
  const names = new Set<string>();
  for (const spec of specs) {
    if (typeof spec === "string") {
      const reference = spec.trim();
      if (!reference) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} MCP server references must not be empty.` });
      }
      if (names.has(reference)) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} repeats MCP server ${reference}.` });
      }
      names.add(reference);
      continue;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} MCP specs must be server-name maps or string references.` });
    }
    if ("start" in spec && typeof (spec as { start?: unknown }).start === "function") {
      throw new PilotDeckError({
        code: "unsupported_capability",
        message: `Agent ${agentName} cannot place an SDK-hosted MCP server directly in an agent spec; configure it for the session and reference its name.`,
      });
    }
    for (const [serverName, server] of Object.entries(spec)) {
      const normalizedName = serverName.trim();
      if (!normalizedName) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} MCP server names must not be empty.` });
      }
      if (names.has(normalizedName)) {
        throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} repeats MCP server ${normalizedName}.` });
      }
      names.add(normalizedName);
      validateAgentMcpTransport(agentName, normalizedName, server);
    }
  }
}

function validateAgentMcpTransport(
  agentName: string,
  serverName: string,
  server: PilotDeckMcpServerConfig,
): void {
  if (isHostedMcpServer(server)) {
    throw new PilotDeckError({
      code: "unsupported_capability",
      message: `Agent ${agentName} MCP server ${serverName} must be a serializable stdio, streamable_http, or sse endpoint.`,
    });
  }
  if (server.type === "sdk" || server.type === "claude_ai_proxy") {
    throw new PilotDeckError({
      code: "unsupported_capability",
      message: `Agent ${agentName} MCP server ${serverName} uses an unsupported transport. PilotDeck supports stdio, streamable_http, and legacy sse.`,
    });
  }
  if (server.type === "stdio" && !server.command.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} MCP server ${serverName} requires a command.` });
  }
  if ((server.type === "http" || server.type === "streamable_http" || server.type === "sse") && !server.url.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: `Agent ${agentName} MCP server ${serverName} requires a URL.` });
  }
  validateDeferredMcpTools((server as { deferredTools?: unknown }).deferredTools, `Agent ${agentName} MCP server ${serverName}`);
}

function serializeAgentMcpServers(
  agentName: string,
  value: NonNullable<import("./types.js").PilotDeckAgentDefinition["mcpServers"]>,
): Record<string, GatewayMcpTransportConfig> | GatewayAgentMcpServerSpec[] {
  const serializeMap = (servers: Record<string, PilotDeckMcpServerConfig>) => Object.fromEntries(
    Object.entries(servers).map(([serverName, server]) => {
      if (isHostedMcpServer(server)) {
        throw new PilotDeckError({
          code: "unsupported_capability",
          message: `Agent ${agentName} MCP server ${serverName} must be serializable for Gateway transport.`,
        });
      }
      return [serverName.trim(), normalizeMcpTransport(server, `Agent ${agentName} MCP server ${serverName}`)];
    }),
  );
  if (!Array.isArray(value)) return serializeMap(value);
  return value.map((spec) => typeof spec === "string" ? spec.trim() : serializeMap(spec));
}

function withoutMcpServers(agent: import("./types.js").PilotDeckAgentDefinition): Omit<import("./types.js").PilotDeckAgentDefinition, "mcpServers"> {
  const { mcpServers: _mcpServers, ...definition } = agent;
  return definition;
}

function normalizeMcpTransport(server: PilotDeckMcpTransportConfig, name: string): GatewayMcpTransportConfig {
  switch (server.type) {
    case "stdio":
    case "streamable_http":
    case "sse":
      return {
        ...server,
        ...(server.deferredTools ? { deferredTools: server.deferredTools.map((tool) => ({ ...tool })) } : {}),
      };
    case "http":
      // Claude's HTTP descriptor maps to the current MCP streamable HTTP wire format.
      return {
        type: "streamable_http",
        url: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
        ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
        ...(server.deferredTools ? { deferredTools: server.deferredTools.map((tool) => ({ ...tool })) } : {}),
      };
    default:
      throw new PilotDeckError({
        code: "unsupported_capability",
        message: `MCP server ${name} uses unsupported Claude transport ${String((server as { type?: unknown }).type)}.`,
      });
  }
}

type PreparedGatewayMcpServers = {
  servers: Record<string, GatewayMcpTransportConfig>;
  newlyStarted: PilotDeckMcpServer[];
};

/**
 * Starts SDK-hosted MCP endpoints and normalizes serializable descriptors for
 * the Gateway. Both Query and resource-client MCP controls use this path so
 * remote reachability and deferred-tool semantics cannot diverge.
 */
async function prepareGatewayMcpServers(
  servers: Record<string, PilotDeckMcpServerConfig>,
  gatewayUrl: string | undefined,
): Promise<PreparedGatewayMcpServers> {
  validateOptions({ mcpServers: servers });
  const nativeServers: Record<string, GatewayMcpTransportConfig> = {};
  const newlyStarted: PilotDeckMcpServer[] = [];
  try {
    for (const [name, server] of Object.entries(servers)) {
      if (isHostedMcpServer(server)) {
        const wasStarted = server.config !== undefined;
        const endpoint = await server.start();
        if (!wasStarted) newlyStarted.push(server);
        if (isLoopbackHttpUrl(endpoint.url) && !isLoopbackGatewayUrl(gatewayUrl)) {
          throw new PilotDeckError({
            code: "unsupported_capability",
            message: `SDK MCP server ${name} is bound to loopback but the configured Gateway is remote. Start it with a publicUrl reachable by that Gateway.`,
          });
        }
        nativeServers[name] = {
          ...endpoint,
          ...(server.deferredTools.length > 0
            ? { deferredTools: server.deferredTools.map((tool) => ({ ...tool })) }
            : {}),
        };
        continue;
      }
      nativeServers[name] = normalizeMcpTransport(server, name);
    }
    return { servers: nativeServers, newlyStarted };
  } catch (error) {
    await Promise.allSettled(newlyStarted.map((server) => server.close()));
    throw error;
  }
}

function validateDeferredMcpTools(value: unknown, label: string): void {
  validateDeferredTools(value, `${label} deferredTools`);
}

function validateDeferredTools(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return true;
    const entry = tool as { name?: unknown; searchHint?: unknown };
    return typeof entry.name !== "string"
      || !entry.name.trim()
      || (entry.searchHint !== undefined && (typeof entry.searchHint !== "string" || !entry.searchHint.trim()));
  })) {
    throw new PilotDeckError({
      code: "validation_error",
      message: `${label} must be a non-empty array of non-empty names and optional non-empty searchHint strings.`,
    });
  }
  const names = value.map((tool) => (tool as { name: string }).name.trim());
  if (new Set(names).size !== names.length) {
    throw new PilotDeckError({ code: "validation_error", message: `${label} cannot contain duplicate names.` });
  }
  if (names.includes("search_tools")) {
    throw new PilotDeckError({ code: "validation_error", message: `${label} cannot include the reserved search_tools name.` });
  }
}

function normalizeSystemPrompt(value: NonNullable<PilotDeckOptions["systemPrompt"]>): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.some((part) => typeof part !== "string")) {
      throw new PilotDeckError({ code: "validation_error", message: "systemPrompt arrays must contain strings." });
    }
    return value.join("\n\n");
  }
  if (value.type === "custom") {
    return normalizeSystemPrompt(value.prompt);
  }
  throw new PilotDeckError({ code: "unsupported_capability", message: "The Claude Code preset systemPrompt has no PilotDeck Gateway equivalent." });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function isPilotDeckJsonSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined
    && typeof schema.type !== "string"
    && (!Array.isArray(schema.type) || schema.type.some((item) => typeof item !== "string"))) return false;
  if (schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false;
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return false;
    if (!Object.values(schema.properties as Record<string, unknown>).every(isPilotDeckJsonSchema)) return false;
  }
  if (schema.items !== undefined && !isPilotDeckJsonSchema(schema.items)) return false;
  return true;
}

function isAbsolutePath(path: string): boolean {
  return typeof path === "string" && isAbsolute(path);
}

async function collectPrompt(stream: AsyncIterable<PilotDeckUserMessage>): Promise<string> {
  const items: string[] = [];
  for await (const item of stream) items.push(userMessageText(item));
  return items.join("\n");
}

function userMessageText(message: PilotDeckUserMessage): string {
  if (message.type === "text") {
    if (typeof message.text !== "string") throw new PilotDeckError({ code: "validation_error", message: "Text user messages require a string text field." });
    return message.text;
  }
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.filter((block) => block?.type === "text").map((block) => block.text).join("");
    if (text) return text;
  }
  throw new PilotDeckError({ code: "validation_error", message: "User messages must contain text content." });
}

export function createQuery(
  prompt: string | AsyncIterable<PilotDeckUserMessage>,
  options: PilotDeckOptions,
  requestedRunId?: string,
): PilotDeckQuery {
  return new PilotDeckQueryImpl(prompt, options, undefined, requestedRunId);
}

/**
 * Creates a query over a caller-supplied Gateway transport. Used by the
 * embedded SDK adapter so the public Query lifecycle is identical to a
 * remote connection while the Gateway remains the state authority.
 */
export function createQueryWithTransport(
  prompt: string | AsyncIterable<PilotDeckUserMessage>,
  options: PilotDeckOptions,
  transport: GatewayTransportClient,
  requestedRunId?: string,
): PilotDeckQuery {
  return new PilotDeckQueryImpl(prompt, options, transport, requestedRunId);
}

export async function createWarmQuery(options: PilotDeckOptions): Promise<PilotDeckWarmQuery> {
  const transport = new GatewayTransport({ ...connectionOptions(options), requestTimeoutMs: options.timeoutMs ?? 30_000 });
  await transport.connect();
  let consumed = false;
  return {
    query(prompt) {
      if (consumed) throw new PilotDeckError({ code: "conflict", message: "A warmed query handle can only start one query." });
      consumed = true;
      return new PilotDeckQueryImpl(prompt, options, transport);
    },
    close: () => transport.close(),
  };
}

export async function createWarmQueryWithTransport(
  options: PilotDeckOptions,
  transport: GatewayTransportClient,
): Promise<PilotDeckWarmQuery> {
  await transport.connect();
  let consumed = false;
  return {
    query(prompt) {
      if (consumed) throw new PilotDeckError({ code: "conflict", message: "A warmed query handle can only start one query." });
      consumed = true;
      return new PilotDeckQueryImpl(prompt, options, transport);
    },
    close: () => transport.close(),
  };
}

export async function listSessions(options: PilotDeckOptions & ListSessionsOptions): Promise<PilotDeckSessionInfo[]> {
  const transport = await connectedTransport(options);
  try { return (await transport.request("list_sessions", { projectKey: options.projectKey, limit: options.limit, cursor: options.cursor }) as GatewayListResult).sessions ?? []; }
  finally { transport.close(); }
}

export async function getSessionMessages(sessionId: string, options: PilotDeckOptions & GetSessionMessagesOptions): Promise<PilotDeckMessage[]> {
  const transport = await connectedTransport(options);
  try { return (await transport.request("read_session_messages", { sessionKey: sessionId, projectKey: options.projectKey, limit: options.limit, cursor: options.cursor }) as GatewayMessagesResult).messages ?? []; }
  finally { transport.close(); }
}

export async function getSessionInfo(sessionId: string, options: PilotDeckOptions & GetSessionInfoOptions): Promise<PilotDeckSessionInfo | undefined> {
  const sessions = await listSessions(options);
  return sessions.find(session => session.sessionId === sessionId || session.sessionKey === sessionId);
}

/** Exports a Gateway-owned session as a portable text conversation archive. */
export async function exportSessionTranscript(
  sessionId: string,
  options: PilotDeckOptions & GetSessionInfoOptions,
): Promise<PilotDeckSessionTranscript> {
  const transport = await connectedTransport(options);
  try {
    return parseSessionTranscript(await transport.request("export_session_transcript", {
      sessionKey: sessionId,
      projectKey: options.projectKey,
    }));
  } finally {
    transport.close();
  }
}

/** Restores a portable transcript into a fresh Gateway-owned session. */
export async function restoreSessionTranscript(
  archive: PilotDeckSessionTranscript,
  options: PilotDeckOptions & RestoreSessionTranscriptOptions,
): Promise<PilotDeckSession> {
  const normalized = parseSessionTranscript(archive);
  const transport = await connectedTransport(options);
  try {
    const created = await transport.request("new_session", {
      projectKey: options.projectKey,
      channelKey: options.channelKey ?? "api_server",
    }) as GatewaySessionResult;
    const restored = await transport.request("restore_session_transcript", {
      sessionKey: created.sessionKey,
      projectKey: options.projectKey,
      archive: normalized,
    }) as GatewayRestoreTranscriptResult;
    if (restored.sessionKey !== created.sessionKey || !Number.isInteger(restored.importedMessages)) {
      throw new PilotDeckError({ code: "server_error", message: "Gateway returned an invalid transcript restore result." });
    }
    return {
      id: created.sessionKey,
      sessionId: created.sessionKey,
      sessionKey: created.sessionKey,
      ...(options.projectKey ? { projectKey: options.projectKey } : {}),
      ...(options.channelKey ? { channelKey: options.channelKey } : {}),
    };
  } finally {
    transport.close();
  }
}

export async function renameSession(sessionId: string, title: string, options: PilotDeckOptions & SessionMutationOptions): Promise<void> {
  const transport = await connectedTransport(options);
  try { await transport.request("rename_session", { sessionKey: sessionId, value: title, projectKey: options.projectKey }); }
  finally { transport.close(); }
}

export async function tagSession(sessionId: string, tag: string | null, options: PilotDeckOptions & SessionMutationOptions): Promise<void> {
  const transport = await connectedTransport(options);
  try { await transport.request("tag_session", { sessionKey: sessionId, value: tag, projectKey: options.projectKey }); }
  finally { transport.close(); }
}

export async function forkSession(sessionId: string, options: PilotDeckOptions & ForkSessionOptions): Promise<PilotDeckSessionInfo> {
  const transport = await connectedTransport(options);
  try {
    let fromEntryId = options.fromEntryId ?? options.upToMessageId;
    if (!fromEntryId) {
      const messages = await transport.request("read_session_messages", { sessionKey: sessionId, projectKey: options.projectKey }) as GatewayMessagesResult;
      fromEntryId = [...(messages.messages ?? [])].reverse().map((message) => String((message as any).entryId ?? (message as any).id ?? "")).find(Boolean);
    }
    if (!fromEntryId) throw new PilotDeckError({ code: "not_found", message: `Session ${sessionId} has no forkable transcript entry.` });
    const result = await transport.request("fork_session", {
      sessionKey: sessionId,
      projectKey: options.projectKey,
      fromEntryId,
      ...(options.resumeAt ? { resumeAt: true } : {}),
      ...(options.resumeDropsTurn ? { resumeDropsTurn: options.resumeDropsTurn } : {}),
    }) as any;
    if (options.title && result.newSessionKey) {
      await transport.request("rename_session", { sessionKey: result.newSessionKey, value: options.title, projectKey: options.projectKey });
    }
    return { sessionKey: result.newSessionKey, sessionId: result.newSessionKey, ...result };
  }
  finally { transport.close(); }
}

/**
 * Read the resolved, redacted settings snapshot from the Gateway host.
 *
 * Unlike Claude's local-process resolver, this intentionally does not inspect
 * the SDK caller's filesystem: a remote Gateway is authoritative for its own
 * `PILOT_HOME`, environment overlays, validation diagnostics and provenance.
 */
export async function resolveSettings(
  options: PilotDeckResolveSettingsOptions,
): Promise<PilotDeckResolvedSettings> {
  const transport = await connectedTransport(options);
  try {
    return await transport.request("resolve_settings", {}) as PilotDeckResolvedSettings;
  } finally {
    transport.close();
  }
}

async function connectedTransport(
  options: Pick<PilotDeckOptions, "gatewayUrl" | "authToken" | "clientVersion" | "timeoutMs" | "reconnect">,
): Promise<GatewayTransport> {
  const transport = new GatewayTransport({ ...connectionOptions(options), requestTimeoutMs: options.timeoutMs ?? 30_000 });
  await transport.connect();
  return transport;
}

type PreparedLastTurnReplacementResult = {
  sessionId: string;
  transactionId: string;
  replacedTurnId: string;
  removedEntryCount: number;
};

function parsePreparedLastTurnReplacement(
  value: unknown,
  expected: { sessionId: string; expectedTurnId: string },
): PreparedLastTurnReplacementResult {
  const result = asRecord(value);
  if (result.sessionKey !== expected.sessionId
    || result.replacedTurnId !== expected.expectedTurnId
    || typeof result.transactionId !== "string"
    || !result.transactionId.trim()
    || !Number.isInteger(result.removedEntryCount)
    || (result.removedEntryCount as number) < 1) {
    throw new PilotDeckError({
      code: "server_error",
      message: "Gateway returned an invalid last-turn replacement transaction.",
    });
  }
  return {
    sessionId: expected.sessionId,
    transactionId: result.transactionId,
    replacedTurnId: expected.expectedTurnId,
    removedEntryCount: result.removedEntryCount as number,
  };
}

function validateReplacementRollback(
  value: unknown,
  expected: Pick<PreparedLastTurnReplacementResult, "sessionId" | "transactionId">,
): void {
  const result = asRecord(value);
  if (result.sessionKey !== expected.sessionId
    || result.transactionId !== expected.transactionId
    || result.action !== "rollback") {
    throw new PilotDeckError({
      code: "server_error",
      message: "Gateway returned an invalid last-turn replacement rollback result.",
    });
  }
}

type ReplacementRunFactory = (
  runId: string,
  input: PilotDeckInput,
  options: PilotDeckLastTurnReplacementRunOptions | undefined,
  onStart: () => void,
) => PilotDeckRunHandle;

/**
 * The SDK remembers only whether its one replacement run has begun. The
 * durable transaction, its timeout, commit-on-accepted-input and recovery
 * remain Gateway-owned.
 */
class PilotDeckLastTurnReplacementImpl implements PilotDeckLastTurnReplacement {
  readonly sessionId: string;
  readonly runId: string;
  readonly replacedTurnId: string;
  readonly removedEntryCount: number;
  private phase: "prepared" | "starting" | "rolling_back" | "rolled_back" = "prepared";
  private runAllocated = false;
  private rollbackInFlight?: Promise<void>;

  constructor(
    private readonly transaction: PreparedLastTurnReplacementResult,
    private readonly rollbackTransaction: () => Promise<void>,
    private readonly createRun: ReplacementRunFactory,
    runId: string,
  ) {
    this.sessionId = transaction.sessionId;
    this.runId = runId;
    this.replacedTurnId = transaction.replacedTurnId;
    this.removedEntryCount = transaction.removedEntryCount;
  }

  start(input: PilotDeckInput, options?: PilotDeckLastTurnReplacementRunOptions): PilotDeckRunHandle {
    if (this.phase !== "prepared") {
      throw new PilotDeckError({
        code: "conflict",
        message: "The prepared last-turn replacement is no longer available to start.",
      });
    }
    if (this.runAllocated) {
      throw new PilotDeckError({
        code: "conflict",
        message: "A prepared last-turn replacement can start exactly one run.",
      });
    }
    this.runAllocated = true;
    return this.createRun(this.runId, input, options, () => {
      if (this.phase !== "prepared") {
        throw new PilotDeckError({
          code: "conflict",
          message: "The prepared last-turn replacement was rolled back before its run started.",
        });
      }
      this.phase = "starting";
    });
  }

  async rollback(): Promise<void> {
    if (this.phase === "rolled_back") return;
    if (this.phase === "rolling_back") return this.rollbackInFlight!;
    if (this.phase !== "prepared") {
      throw new PilotDeckError({
        code: "conflict",
        message: "A replacement run has started; the Gateway now owns its commit or rollback outcome.",
      });
    }
    this.phase = "rolling_back";
    this.rollbackInFlight = this.rollbackTransaction().then(
      () => {
        this.phase = "rolled_back";
      },
      (error) => {
        this.phase = "prepared";
        this.rollbackInFlight = undefined;
        throw error;
      },
    );
    return this.rollbackInFlight;
  }
}

function createRunHandle(
  run: PilotDeckQuery,
  id: string,
  sessionId: string,
  onStart?: () => void,
): PilotDeckRunHandle {
  let started = false;
  const begin = () => {
    if (started) return;
    onStart?.();
    started = true;
  };
  return {
    id,
    sessionId,
    events: (options) => {
      const source = abortableEvents(run, options?.signal);
      return {
        [Symbol.asyncIterator](): AsyncIterator<PilotDeckMessage> {
          const iterator = source[Symbol.asyncIterator]();
          return {
            next: async () => {
              begin();
              const item = await iterator.next();
              if (item.done) run.close();
              return item;
            },
            return: async () => iterator.return
              ? await iterator.return()
              : { done: true, value: undefined as never },
            throw: async (error) => iterator.throw
              ? await iterator.throw(error)
              : Promise.reject(error),
          };
        },
      };
    },
    result: (options) => {
      begin();
      if (options?.signal?.aborted) return Promise.reject(abortError(options.signal, "Run result observation aborted."));
      // A resource-client run owns a separate observation transport. Closing
      // it after its terminal result never aborts the Gateway-owned run, but
      // prevents a completed run from keeping a remote Gateway listener open.
      const terminal = run.result().finally(() => run.close());
      return awaitWithSignal(terminal, options?.signal, "Run result observation aborted.");
    },
    steer: async (input) => {
      begin();
      return await run.steer(input);
    },
    cancelSteer: async (itemId) => {
      begin();
      return await run.cancelSteer(itemId);
    },
    abort: async (reason) => {
      begin();
      await run.abort(reason);
    },
  };
}

/**
 * Prepares a Gateway transaction that removes the latest accepted turn.
 *
 * The returned handle can start one replacement run with the reserved run id
 * or roll the transcript back before that run begins. This helper opens short
 * control connections; use `client.sessions.prepareLastTurnReplacement()`
 * when a long-lived resource client already exists.
 */
export async function prepareLastTurnReplacement(
  sessionId: string,
  options: PilotDeckOptions & PrepareLastTurnReplacementOptions,
): Promise<PilotDeckLastTurnReplacement> {
  if (!sessionId.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
  }
  if (!options.expectedTurnId?.trim()) {
    throw new PilotDeckError({ code: "validation_error", message: "expectedTurnId is required." });
  }
  const transport = await connectedTransport(options);
  let transaction: PreparedLastTurnReplacementResult;
  const replacementRunId = randomUUID();
  try {
    transaction = parsePreparedLastTurnReplacement(await transport.request("replace_last_turn", {
      sessionKey: sessionId,
      projectKey: options.projectKey,
      expectedTurnId: options.expectedTurnId,
      replacementTurnId: replacementRunId,
    }), { sessionId, expectedTurnId: options.expectedTurnId });
  } finally {
    transport.close();
  }

  const rollbackTransaction = async () => {
    const rollbackTransport = await connectedTransport(options);
    try {
      validateReplacementRollback(await rollbackTransport.request("finalize_last_turn_replacement", {
        sessionKey: transaction.sessionId,
        projectKey: options.projectKey,
        transactionId: transaction.transactionId,
        action: "rollback",
      }), transaction);
    } finally {
      rollbackTransport.close();
    }
  };
  const createRun: ReplacementRunFactory = (runId, input, runOptions, onStart) => {
    const queryOptions: PilotDeckOptions = {
      ...options,
      ...(runOptions ?? {}),
      gatewayUrl: options.gatewayUrl,
      authToken: options.authToken,
      clientVersion: options.clientVersion,
      projectKey: options.projectKey,
      sessionId: transaction.sessionId,
    };
    const run = createQuery(userMessageText(input), queryOptions, runId);
    return createRunHandle(run, runId, transaction.sessionId, onStart);
  };
  return new PilotDeckLastTurnReplacementImpl(transaction, rollbackTransaction, createRun, replacementRunId);
}

export function createPilotDeckClient(defaults: PilotDeckConnectionOptions & Partial<PilotDeckOptions>): PilotDeckClient {
  const connection = connectionOptions(defaults);
  return createPilotDeckClientWithTransportFactory(defaults, () => new GatewayTransport({
    ...connection,
    requestTimeoutMs: defaults.timeoutMs ?? 30_000,
  }));
}

/**
 * Builds the public resource client over a Gateway protocol transport factory.
 *
 * This is intentionally an SDK-internal composition point rather than a
 * direct AgentLoop adapter: every call, including embedded calls, continues
 * to use the authoritative Gateway wire dispatcher. Query transports are
 * separate from the client control transport so closing a query never closes
 * the client or changes a Gateway-owned run.
 */
export function createPilotDeckClientWithTransportFactory(
  defaults: Partial<PilotDeckOptions>,
  createTransport: () => GatewayTransportClient,
): PilotDeckClient {
  const merged = (options?: PilotDeckOptions) => ({ ...defaults, ...(options ?? {}) });
  const transport = createTransport();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new PilotDeckError({ code: "transport_error", message: "PilotDeck client is closed." });
  };
  const connect = async (): Promise<PilotDeckServerInfo> => {
    assertOpen();
    return transport.connect();
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    await connect();
    return transport.request(method, params);
  };
  const session = (sessionKey: string, input: { projectKey?: string; channelKey?: string } = {}): PilotDeckSession => ({
    id: sessionKey,
    sessionId: sessionKey,
    sessionKey,
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    ...(input.channelKey ? { channelKey: input.channelKey } : {}),
  });
  const sessionFromInfo = (value: PilotDeckSessionInfo, fallback?: string): PilotDeckSession => {
    const sessionKey = String(value.sessionKey ?? value.sessionId ?? fallback ?? "");
    if (!sessionKey) throw new PilotDeckError({ code: "server_error", message: "Gateway session response has no session key." });
    return { ...value, ...session(sessionKey, { projectKey: value.projectKey as string | undefined, channelKey: value.channelKey as string | undefined }) };
  };
  const deleteMirror = async (sessionId: string, projectKey?: string): Promise<void> => {
    const store = defaults.sessionStore;
    const effectiveProjectKey = projectKey ?? defaults.projectKey;
    if (!store?.delete || !effectiveProjectKey) return;
    try {
      await store.delete({ projectKey: effectiveProjectKey, sessionId });
      if (store.listSubkeys) {
        for (const subpath of await store.listSubkeys({ projectKey: effectiveProjectKey, sessionId })) {
          await store.delete({ projectKey: effectiveProjectKey, sessionId, subpath });
        }
      }
    } catch {
      // The Gateway delete committed. A mirror cleanup failure must not make it look unsuccessful.
    }
  };
  return {
    connect,
    describeServer: async () => await request("describe_server", {}) as PilotDeckServerInfo,
    close: async () => {
      if (closed) return;
      closed = true;
      transport.close();
    },
    query: (prompt, options) => {
      assertOpen();
      return createQueryWithTransport(prompt, merged(options), createTransport());
    },
    startup: (options) => {
      assertOpen();
      return createWarmQueryWithTransport(merged({ timeoutMs: options?.initializeTimeoutMs }), createTransport());
    },
    sessions: {
      create: async (input = {}) => {
        const created = await request("new_session", {
          projectKey: input.projectKey ?? defaults.projectKey,
          channelKey: input.channelKey ?? defaults.channelKey ?? "api_server",
          hint: input.hint,
        }) as GatewaySessionResult;
        return session(created.sessionKey, { projectKey: input.projectKey ?? defaults.projectKey, channelKey: input.channelKey ?? defaults.channelKey });
      },
      get: async (id, options) => {
        const listed = await request("list_sessions", { projectKey: options?.projectKey ?? defaults.projectKey }) as GatewayListResult;
        const found = listed.sessions?.find((candidate) => candidate.sessionId === id || candidate.sessionKey === id);
        if (!found) throw new PilotDeckError({ code: "not_found", message: `Session not found: ${id}` });
        return sessionFromInfo(found, id);
      },
      resume: async (id, options) => {
        const resumed = await request("resume_session", { sessionKey: id }) as GatewaySessionResult;
        return session(resumed.sessionKey, { projectKey: options?.projectKey ?? defaults.projectKey });
      },
      list: async (options) => (await request("list_sessions", { projectKey: options?.projectKey ?? defaults.projectKey, limit: options?.limit, cursor: options?.cursor }) as GatewayListResult).sessions ?? [],
      messages: async (id, options) => (await request("read_session_messages", { sessionKey: id, projectKey: options?.projectKey ?? defaults.projectKey, limit: options?.limit, cursor: options?.cursor }) as GatewayMessagesResult).messages ?? [],
      info: async (id, options) => {
        const listed = await request("list_sessions", { projectKey: options?.projectKey ?? defaults.projectKey }) as GatewayListResult;
        return listed.sessions?.find((candidate) => candidate.sessionId === id || candidate.sessionKey === id);
      },
      exportTranscript: async (id, options) => parseSessionTranscript(await request("export_session_transcript", {
        sessionKey: id,
        projectKey: options?.projectKey ?? defaults.projectKey,
      })),
      restoreTranscript: async (archive, options = {}) => {
        const normalized = parseSessionTranscript(archive);
        const projectKey = options.projectKey ?? defaults.projectKey;
        const channelKey = options.channelKey ?? defaults.channelKey ?? "api_server";
        const created = await request("new_session", { projectKey, channelKey }) as GatewaySessionResult;
        const restored = await request("restore_session_transcript", {
          sessionKey: created.sessionKey,
          projectKey,
          archive: normalized,
        }) as GatewayRestoreTranscriptResult;
        if (restored.sessionKey !== created.sessionKey || !Number.isInteger(restored.importedMessages)) {
          throw new PilotDeckError({ code: "server_error", message: "Gateway returned an invalid transcript restore result." });
        }
        return session(created.sessionKey, { projectKey, channelKey });
      },
      fork: async (id, options = {}) => {
        let fromEntryId = options.fromEntryId ?? options.upToMessageId;
        if (!fromEntryId) {
          const messages = await request("read_session_messages", { sessionKey: id, projectKey: options.projectKey ?? defaults.projectKey }) as GatewayMessagesResult;
          fromEntryId = [...(messages.messages ?? [])].reverse().map((message) => String((message as any).entryId ?? (message as any).id ?? "")).find(Boolean);
        }
        if (!fromEntryId) throw new PilotDeckError({ code: "not_found", message: `Session ${id} has no forkable transcript entry.` });
        const forked = await request("fork_session", {
          sessionKey: id,
          projectKey: options.projectKey ?? defaults.projectKey,
          fromEntryId,
          ...(options.resumeAt ? { resumeAt: true } : {}),
          ...(options.resumeDropsTurn ? { resumeDropsTurn: options.resumeDropsTurn } : {}),
        }) as { newSessionKey?: string };
        if (!forked.newSessionKey) throw new PilotDeckError({ code: "server_error", message: "Gateway did not return a forked session id." });
        if (options.title) await request("rename_session", { sessionKey: forked.newSessionKey, projectKey: options.projectKey ?? defaults.projectKey, value: options.title });
        return { sessionId: forked.newSessionKey, sessionKey: forked.newSessionKey, ...(options.title ? { customTitle: options.title } : {}) };
      },
      prepareLastTurnReplacement: async (id, options) => {
        if (!id.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
        }
        if (!options.expectedTurnId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "expectedTurnId is required." });
        }
        const projectKey = options.projectKey ?? defaults.projectKey;
        const replacementRunId = randomUUID();
        const transaction = parsePreparedLastTurnReplacement(await request("replace_last_turn", {
          sessionKey: id,
          projectKey,
          expectedTurnId: options.expectedTurnId,
          replacementTurnId: replacementRunId,
        }), { sessionId: id, expectedTurnId: options.expectedTurnId });
        const rollbackTransaction = async () => {
          validateReplacementRollback(await request("finalize_last_turn_replacement", {
            sessionKey: transaction.sessionId,
            projectKey,
            transactionId: transaction.transactionId,
            action: "rollback",
          }), transaction);
        };
        const createRun: ReplacementRunFactory = (runId, input, runOptions, onStart) => {
          assertOpen();
          const query = createQueryWithTransport(
            userMessageText(input),
            {
              ...merged(runOptions),
              projectKey,
              sessionId: transaction.sessionId,
            },
            createTransport(),
            runId,
          );
          return createRunHandle(query, runId, transaction.sessionId, onStart);
        };
        return new PilotDeckLastTurnReplacementImpl(
          transaction,
          rollbackTransaction,
          createRun,
          replacementRunId,
        );
      },
      close: async (id, options) => { await request("close_session", { sessionKey: id, reason: options?.reason }); },
      rename: async (id, title, options) => { await request("rename_session", { sessionKey: id, value: title, projectKey: options?.projectKey ?? defaults.projectKey }); },
      tag: async (id, tag, options) => { await request("tag_session", { sessionKey: id, value: tag, projectKey: options?.projectKey ?? defaults.projectKey }); },
      delete: async (id, options) => {
        const projectKey = options?.projectKey ?? defaults.projectKey;
        await request("delete_session", { sessionKey: id, projectKey });
        await deleteMirror(id, projectKey);
      },
    },
    runs: {
      start: (input) => {
        assertOpen();
        const id = randomUUID();
        const run = createQueryWithTransport(
          userMessageText(input.input),
          merged({ ...(input.options ?? {}), sessionId: input.sessionId }),
          createTransport(),
          id,
        );
        return createRunHandle(run, id, input.sessionId);
      },
    },
    projects: {
      list: async () => (await request("list_projects", {}) as { projects?: PilotDeckProject[] }).projects ?? [],
      get: async (projectKey) => await request("describe_project", { projectKey }) as PilotDeckProject,
    },
    files: {
      list: async (input) => {
        const result = await request("project_files_list", input) as { items?: PilotDeckFileEntry[]; nextCursor?: string };
        return { items: result.items ?? [], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
      },
      read: async (input) => {
        const result = await request("project_file_read", input) as { path?: string; content?: string; encoding?: "utf-8" | "base64" } | null;
        return result?.content === undefined ? null : { path: result.path ?? input.path, content: result.content, encoding: result.encoding };
      },
    },
    models: {
      list: async (input) => (await request("model_catalog_list", input) as { items?: PilotDeckModel[] }).items ?? [],
      get: async (input) => await request("session_model_get", { sessionKey: input.sessionId, projectKey: input.projectKey }) as Record<string, unknown>,
      set: async (input) => await request("session_model_set", { sessionKey: input.sessionId, projectKey: input.projectKey, selection: input.selection }) as Record<string, unknown>,
      clear: async (input) => { await request("session_model_clear", { sessionKey: input.sessionId, projectKey: input.projectKey }); },
    },
    commands: {
      list: async (input) => {
        const result = await request("commands_list", input) as { pinned?: PilotDeckCommand[]; builtIn?: PilotDeckCommand[]; custom?: PilotDeckCommand[]; nextCursor?: string };
        return { items: [...(result.pinned ?? []), ...(result.builtIn ?? []), ...(result.custom ?? [])], ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
      },
    },
    skills: {
      list: async (input = {}) => (await request("skill_list", input) as { items?: PilotDeckSkill[] }).items ?? [],
      read: async (input) => await request("skill_read", input) as PilotDeckSkill,
    },
    mcp: {
      status: async (input = {}) => {
        const result = await request("mcp_server_status", {
          projectKey: input.projectKey ?? defaults.projectKey,
          ...(input.sessionId ? { sessionKey: input.sessionId } : {}),
        }) as { servers?: PilotDeckMcpStatus[] };
        return result.servers ?? [];
      },
      setServers: async (input: PilotDeckSetMcpServersInput) => {
        if (!input.sessionId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
        }
        let newlyStarted: PilotDeckMcpServer[] = [];
        try {
          const prepared = await prepareGatewayMcpServers(input.servers, defaults.gatewayUrl);
          newlyStarted = prepared.newlyStarted;
          const result = await request("set_mcp_servers", {
            sessionKey: input.sessionId,
            projectKey: input.projectKey ?? defaults.projectKey,
            servers: prepared.servers,
          }) as PilotDeckMcpSetResult & { errors?: Array<{ name: string; error: string }> };
          if (input.strict === true && Array.isArray(result.errors) && result.errors.length > 0) {
            throw new PilotDeckError({
              code: "validation_error",
              message: `Gateway rejected MCP server configuration: ${result.errors.map((error) => `${error.name}: ${error.error}`).join("; ")}`,
              details: result.errors,
            });
          }
          return result;
        } catch (error) {
          if (input.strict === true) {
            await Promise.allSettled(newlyStarted.map((server) => server.close()));
          }
          throw error;
        }
      },
      reconnect: async (input: PilotDeckMcpSessionInput & { serverName: string }) => {
        if (!input.sessionId?.trim() || !input.serverName?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId and serverName are required." });
        }
        await request("mcp_server_reconnect", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          serverName: input.serverName,
        });
      },
      toggle: async (input: PilotDeckToggleMcpServerInput) => {
        if (!input.sessionId?.trim() || !input.serverName?.trim() || typeof input.enabled !== "boolean") {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId, serverName, and boolean enabled are required." });
        }
        await request("mcp_server_toggle", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          serverName: input.serverName,
          enabled: input.enabled,
        });
      },
      setPermissionModeOverride: async (input: PilotDeckMcpPermissionModeOverrideInput) => {
        if (!input.sessionId?.trim() || !input.serverName?.trim()
          || (input.mode !== "default" && input.mode !== "auto" && input.mode !== null)) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId, serverName, and a valid MCP permission mode are required." });
        }
        return await request("set_mcp_permission_mode_override", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          serverName: input.serverName,
          mode: input.mode,
        }) as { warning?: string };
      },
    },
    dialogs: {
      list: async (input) => {
        if (!input.sessionId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
        }
        const result = await request("user_dialog_list", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
        }) as { dialogs?: PilotDeckMessage[] };
        return (result.dialogs ?? []).map((dialog) => parseUserDialogRecord(dialog, input.sessionId));
      },
      watch: async (input, listener) => {
        if (!input.sessionId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId is required." });
        }
        if (typeof listener !== "function") {
          throw new PilotDeckError({ code: "validation_error", message: "A user dialog watch listener is required." });
        }
        await connect();
        if (!transport.onNotification) throw unsupported("dialogs.watch");
        const sessionId = input.sessionId;
        const projectKey = input.projectKey ?? defaults.projectKey;
        return transport.onNotification((notification) => {
          if (notification.name !== "user_dialog_changed") return;
          const change = parseUserDialogChange(notification.payload, sessionId, projectKey);
          if (!change) return;
          try {
            listener(change);
          } catch {
            // Application listeners cannot affect Gateway-owned dialog state.
          }
        });
      },
      claim: async (input) => {
        if (!input.sessionId?.trim() || !input.requestId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId and requestId are required." });
        }
        if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 300_000)) {
          throw new PilotDeckError({ code: "validation_error", message: "ttlMs must be a safe integer between 1000 and 300000." });
        }
        const leaseId = normalizeUserDialogLeaseId(input.leaseId, "leaseId");
        const response = await request("user_dialog_claim", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          requestId: input.requestId,
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
          ...(leaseId ? { leaseId } : {}),
        }) as { claimed?: unknown; leaseId?: unknown; expiresAt?: unknown; reason?: unknown };
        if (response.claimed === true) {
          if (typeof response.leaseId !== "string" || !response.leaseId.trim()
            || typeof response.expiresAt !== "string" || !response.expiresAt.trim()) {
            throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid user dialog claim." });
          }
          return { claimed: true, leaseId: response.leaseId, expiresAt: response.expiresAt };
        }
        if (response.claimed !== false || (response.reason !== "claimed" && response.reason !== "not_pending")) {
          throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid user dialog claim result." });
        }
        if (response.expiresAt !== undefined && (typeof response.expiresAt !== "string" || !response.expiresAt.trim())) {
          throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid user dialog lease expiry." });
        }
        return {
          claimed: false,
          reason: response.reason,
          ...(typeof response.expiresAt === "string" ? { expiresAt: response.expiresAt } : {}),
        };
      },
      release: async (input) => {
        if (!input.sessionId?.trim() || !input.requestId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId and requestId are required." });
        }
        const leaseId = normalizeUserDialogLeaseId(input.leaseId, "leaseId");
        if (!leaseId) throw new PilotDeckError({ code: "validation_error", message: "leaseId is required." });
        const response = await request("user_dialog_release", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          requestId: input.requestId,
          leaseId,
        }) as { released?: unknown };
        if (typeof response.released !== "boolean") {
          throw new PilotDeckError({ code: "validation_error", message: "Gateway returned an invalid user dialog release result." });
        }
        return { released: response.released };
      },
      respond: async (input) => {
        if (!input.sessionId?.trim() || !input.requestId?.trim()) {
          throw new PilotDeckError({ code: "validation_error", message: "sessionId and requestId are required." });
        }
        const leaseId = normalizeUserDialogLeaseId(input.leaseId, "leaseId");
        const response = await request("user_dialog_respond", {
          sessionKey: input.sessionId,
          projectKey: input.projectKey ?? defaults.projectKey,
          requestId: input.requestId,
          ...(leaseId ? { leaseId } : {}),
          result: userDialogResponsePayload(input.result),
        }) as { delivered?: boolean; recovered?: unknown; reason?: unknown };
        return {
          delivered: response.delivered === true,
          ...(response.recovered === true ? { recovered: true as const } : {}),
          ...(response.reason === "gateway_restarted" ? { reason: "gateway_restarted" as const } : {}),
        };
      },
    },
    cron: {
      create: async (input) => {
        const { sessionId, ...rest } = input;
        const result = await request("cron_create", {
          ...rest,
          ...(sessionId ? { sessionKey: sessionId } : {}),
        }) as { task: PilotDeckCronTask };
        return result.task;
      },
      list: async (input = {}) => await request("cron_list", input) as PilotDeckCronListResult,
      update: async (input) => await request("cron_update", input) as ReturnType<PilotDeckClient["cron"]["update"]> extends Promise<infer Result> ? Result : never,
      delete: async (input) => await request("cron_delete", input) as PilotDeckCronDeleteResult,
      stop: async (input) => await request("cron_stop", input) as PilotDeckCronStopResult,
      runNow: async (input) => await request("cron_run_now", input) as PilotDeckCronRunNowResult,
    },
    config: { reload: async () => await request("reload_config", {}) as PilotDeckReloadResult },
    extensions: { reload: async (input) => await request("reload_extensions", input ?? {}) as PilotDeckReloadResult },
  };
}

function abortError(signal: AbortSignal, message: string): AbortError {
  return new AbortError(message, signal.reason);
}

function awaitWithSignal<T>(value: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) return Promise.reject(abortError(signal, message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal, message));
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function abortableEvents(source: AsyncIterable<PilotDeckMessage>, signal?: AbortSignal): AsyncIterable<PilotDeckMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<PilotDeckMessage> {
      const iterator = source[Symbol.asyncIterator]();
      return {
        next: () => {
          if (signal?.aborted) return Promise.reject(abortError(signal, "Run event observation aborted."));
          return awaitWithSignal(iterator.next(), signal, "Run event observation aborted.");
        },
        return: async () => {
          if (iterator.return) return iterator.return();
          return { done: true, value: undefined as never };
        },
        throw: async (error) => {
          if (iterator.throw) return iterator.throw(error);
          throw error;
        },
      };
    },
  };
}

export function defineTool<Input = unknown, Schema = unknown>(name: string, description: string, inputSchema: Schema, handler: PilotDeckToolHandler<Input>, extras?: PilotDeckToolExtras): PilotDeckToolDefinition<Input, Schema> {
  return { name, description, inputSchema, handler, extras };
}

/**
 * Convert a Claude-like SDK tool descriptor into the structural tool shape
 * consumed by the embedded PilotDeck Gateway. The host still owns permission,
 * validation, scheduling and side effects; this adapter only bridges the
 * handler call and never serializes JavaScript functions over WebSocket.
 */
export function toEmbeddedTool<Input, Schema>(tool: PilotDeckToolDefinition<Input, Schema>): PilotDeckEmbeddedToolDefinition<Input, Schema> {
  const readOnly = tool.extras?.annotations?.readOnly === true;
  return {
    name: tool.name,
    description: tool.description,
    kind: "custom",
    inputSchema: tool.inputSchema,
    ...(tool.extras?.alwaysLoad !== undefined ? { alwaysLoad: tool.extras.alwaysLoad } : {}),
    ...(tool.extras?.searchHint ? { searchHint: tool.extras.searchHint } : {}),
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    ...(tool.extras?.annotations?.destructive !== undefined ? { isDestructive: () => tool.extras!.annotations!.destructive === true } : {}),
    execute: async (input, context) => {
      const result = await tool.handler(input as Input, { signal: context?.abortSignal ?? new AbortController().signal, toolUseId: context?.currentToolCallId ?? context?.turnId });
      return { content: result.content as Array<Record<string, unknown>>, ...(result.isError ? { metadata: { isError: true } } : {}) };
    },
  };
}

export function createPilotDeckMcpServer(options: PilotDeckMcpServerOptions): import("./types.js").PilotDeckMcpServer {
  return new PilotDeckMcpServerImpl(options);
}

/** Claude Agent SDK-compatible spelling for a SDK-hosted MCP server. */
export const createSdkMcpServer = createPilotDeckMcpServer;

function isHostedMcpServer(server: PilotDeckMcpServerConfig): server is PilotDeckMcpServer {
  return typeof server === "object" && server !== null && "start" in server && typeof (server as PilotDeckMcpServer).start === "function";
}

function isLoopbackGatewayUrl(value: string | undefined): boolean {
  if (!value) return false;
  try { return isLoopbackHost(new URL(value).hostname); }
  catch { return false; }
}

function isLoopbackHttpUrl(value: string): boolean {
  try { return isLoopbackHost(new URL(value).hostname); }
  catch { return false; }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export async function deleteSession(sessionId: string, options: PilotDeckOptions & SessionMutationOptions): Promise<void> {
  const transport = await connectedTransport(options);
  try {
    await transport.request("delete_session", { sessionKey: sessionId, projectKey: options.projectKey });
    await deleteSessionMirror(sessionId, options);
  }
  finally { transport.close(); }
}

export async function getSubagentMessages(sessionId: string, agentId: string, options: PilotDeckOptions & { projectKey?: string } = {}): Promise<PilotDeckMessage[]> {
  const transport = await connectedTransport(options);
  try {
    const result = await transport.request("read_subagent_messages", { sessionKey: sessionId, subagentId: agentId, projectKey: options.projectKey }) as GatewayMessagesResult;
    return result.messages ?? [];
  } finally { transport.close(); }
}

export async function listSubagents(sessionId: string, options: PilotDeckOptions & { projectKey?: string } = {}): Promise<string[]> {
  const messages = await getSessionMessages(sessionId, options);
  return [...new Set(messages.map((message) => String((message as any).subagentId ?? (message as any).agentId ?? "")).filter(Boolean))];
}

async function deleteSessionMirror(sessionId: string, options: Pick<PilotDeckOptions, "sessionStore" | "projectKey">): Promise<void> {
  const store = options.sessionStore;
  if (!store?.delete || !options.projectKey) return;
  try {
    await store.delete({ projectKey: options.projectKey, sessionId });
    if (store.listSubkeys) {
      for (const subpath of await store.listSubkeys({ projectKey: options.projectKey, sessionId })) {
        await store.delete({ projectKey: options.projectKey, sessionId, subpath });
      }
    }
  } catch {
    // A failed local cleanup cannot turn a committed Gateway deletion into a failure.
  }
}
