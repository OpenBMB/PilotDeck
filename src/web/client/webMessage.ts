/**
 * Web-facing message DTO + reducer.
 *
 * Live `WebGatewayEvent` and historical transcript replays are projected onto
 * the same `WebMessage[]` shape so the React UI does not have to branch on
 * "live vs history" code paths.
 */

import type { WebGatewayEvent } from "./protocol.js";
import { isVisibleFailureStatusDetail } from "../../status/agentStatus.js";

function normalizeToolDisplayName(name: string): string {
  const aliases: Record<string, string> = {
    agent: "Task",
    ask_user_question: "AskUserQuestion",
    bash: "Bash",
    edit_file: "Edit",
    glob: "Glob",
    grep: "Grep",
    read_file: "Read",
    write_file: "Write",
  };
  if (aliases[name]) return aliases[name];
  if (name === "todo_write") return "TodoWrite";
  if (name === "todo_read") return "TodoRead";
  return name;
}

function isReadOnlyModeToolDenyText(text: unknown): "plan_mode_denied" | "ask_mode_denied" | undefined {
  if (typeof text !== "string") return undefined;
  if (/\[PLAN_MODE_VIOLATION\]/i.test(text) || /plan mode denies side-effecting tool\b/i.test(text)) {
    return "plan_mode_denied";
  }
  if (/\[ASK_MODE_VIOLATION\]/i.test(text) || /ask mode denies side-effecting tool\b/i.test(text)) {
    return "ask_mode_denied";
  }
  return undefined;
}

function normalizeToolErrorCode(errorCode: string | undefined, resultPreview: unknown): string | undefined {
  if (errorCode === "plan_mode_violation") return "plan_mode_denied";
  if (errorCode === "ask_mode_violation") return "ask_mode_denied";
  return isReadOnlyModeToolDenyText(resultPreview) ?? errorCode;
}

const ERROR_AGENT_STATUS_EVENTS = new Set([
  "model_empty_response_exhausted",
  "max_turns_reached",
  "max_output_recovery_exhausted",
  "model_request_failed",
  "tool_call_recovery_exhausted",
  "tool_error_loop",
  "lifecycle_blocked",
  "turn_failed",
  "turn_timeout",
  "gateway_submit_failed",
  "session_busy",
  "gateway_bridge_error",
  "gateway_stream_ended_without_completion",
  "web_http_request_failed",
  "project_unavailable",
  "config_invalid",
  "gateway_unavailable",
  "channel_submit_failed",
  "subagent_failed",
  "content_filter_stop",
  "unknown_finish_reason",
]);

const STATUS_AGENT_STATUS_EVENTS = new Set([
  "structured_output_completed",
  "turn_aborted",
]);

export type WebMessageRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "permission"
  | "error";

export type WebMessageKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "permission_request"
  | "elicitation_request"
  | "status"
  | "complete"
  | "interrupted"
  | "error"
  | "structured_output"
  | "compact_boundary";

export type WebMessage = {
  id: string;
  sessionKey: string;
  projectKey?: string;
  createdAt: string;
  provider: "pilotdeck" | (string & {});
  role: WebMessageRole;
  kind: WebMessageKind;
  toolCallId?: string;
  toolName?: string;
  requestId?: string;
  ok?: boolean;
  text?: string;
  contentI18n?: { key: string; params?: Record<string, unknown> };
  userHintI18n?: { key: string; params?: Record<string, unknown> };
  images?: Array<{
    data: string;
    name?: string;
    mimeType?: string;
  }>;
  /**
   * `PilotDeckToolErrorCode` of the underlying failure when
   * `kind === 'tool_result'` and `ok === false`. Empty for non-error or
   * non-tool-result frames. See `chatPermissions.ts` for how the host UI
   * uses this.
   */
  errorCode?: string;
  resultPath?: string;
  /** UUID of the subagent spawned by this tool_use (agent/Task) call. */
  subagentId?: string;
  payload?: unknown;
  source: "live" | "history";
  finishReason?: string;
  usage?: Record<string, number>;
  /** Transcript entry id when projected from history (used for history fork). */
  entryId?: string;
};

export type WebMessageReducerOptions = {
  sessionKey: string;
  projectKey?: string;
  /** Returns ISO 8601 timestamp; injected for deterministic tests. */
  now?: () => Date;
  /** Generates stable ids; injected for deterministic tests. */
  newId?: () => string;
};

export type WebMessageReducerState = {
  messages: WebMessage[];
  /** Active assistant message id where new text deltas are appended. */
  currentAssistantId?: string;
  /** Active assistant thinking id where thinking deltas are appended. */
  currentThinkingId?: string;
  /** Map toolCallId -> message id so we can flip to tool_result on finish. */
  toolMessageByCallId: Record<string, string>;
  /** True after this turn has already shown a visible failure status. */
  hasVisibleFailureStatus: boolean;
};

export function createWebMessageReducerState(): WebMessageReducerState {
  return {
    messages: [],
    toolMessageByCallId: {},
    hasVisibleFailureStatus: false,
  };
}

const MAX_WEB_TOOL_RESULT_PREVIEW_CHARS = 20_000;

function limitToolResultPreview(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_WEB_TOOL_RESULT_PREVIEW_CHARS) {
    return value;
  }
  const headLength = Math.floor(MAX_WEB_TOOL_RESULT_PREVIEW_CHARS / 2);
  const tailLength = MAX_WEB_TOOL_RESULT_PREVIEW_CHARS - headLength;
  return `${value.slice(0, headLength)}\n\n... [UI preview truncated: ${value.length - MAX_WEB_TOOL_RESULT_PREVIEW_CHARS} characters omitted] ...\n\n${value.slice(-tailLength)}`;
}

export function applyWebGatewayEvent(
  state: WebMessageReducerState,
  event: WebGatewayEvent,
  options: WebMessageReducerOptions,
): WebMessageReducerState {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultNewId;
  const stamp = now().toISOString();

  switch (event.type) {
    case "turn_started":
      return {
        ...state,
        currentAssistantId: undefined,
        currentThinkingId: undefined,
        hasVisibleFailureStatus: false,
      };

    case "assistant_text_delta": {
      if (!event.text) {
        return state;
      }
      if (state.currentAssistantId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.currentAssistantId
              ? { ...m, text: `${m.text ?? ""}${event.text}` }
              : m,
          ),
        };
      }
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "assistant",
        kind: "text",
        text: event.text,
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: id,
      };
    }

    case "assistant_thinking_delta": {
      if (!event.text) {
        return state;
      }
      if (state.currentThinkingId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.currentThinkingId
              ? { ...m, text: `${m.text ?? ""}${event.text}` }
              : m,
          ),
        };
      }
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "assistant",
        kind: "thinking",
        text: event.text,
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentThinkingId: id,
      };
    }

    case "tool_call_started": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_use",
        toolCallId: event.toolCallId,
        toolName: normalizeToolDisplayName(event.name),
        text: event.argsPreview,
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        toolMessageByCallId: {
          ...state.toolMessageByCallId,
          [event.toolCallId]: id,
        },
        currentAssistantId: undefined,
      };
    }

    case "tool_call_finished": {
      const normalizedErrorCode = normalizeToolErrorCode(event.errorCode, event.resultPreview);
      const eventImages =
        Array.isArray(event.images) && event.images.length > 0
          ? event.images.map((image) => ({
              data: `data:${image.mimeType};base64,${image.data}`,
              mimeType: image.mimeType,
            }))
          : undefined;
      const matchedId = state.toolMessageByCallId[event.toolCallId];
      if (matchedId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === matchedId
              ? {
                  ...m,
                  kind: "tool_result",
                  ok: event.ok,
                  text: limitToolResultPreview(event.resultPreview) ?? m.text,
                  ...(eventImages ? { images: eventImages } : {}),
                  ...(normalizedErrorCode && { errorCode: normalizedErrorCode }),
                }
              : m,
          ),
        };
      }
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: event.toolCallId,
        ok: event.ok,
        text: limitToolResultPreview(event.resultPreview),
        ...(eventImages ? { images: eventImages } : {}),
        ...(normalizedErrorCode && { errorCode: normalizedErrorCode }),
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
      };
    }

    case "tool_result_detail_available": {
      const matchedId = state.toolMessageByCallId[event.toolCallId];
      if (!matchedId) {
        return state;
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === matchedId
            ? {
                ...m,
                ...(event.resultPath ? { resultPath: event.resultPath } : {}),
              }
            : m,
        ),
      };
    }

    case "permission_request": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "permission",
        kind: "permission_request",
        requestId: event.requestId,
        toolName: event.toolName,
        payload: event.payload,
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: undefined,
      };
    }

    case "elicitation_request": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "system",
        kind: "elicitation_request",
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        payload: {
          questions: event.questions,
          previewFormat: event.previewFormat,
          metadata: event.metadata,
        },
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: undefined,
      };
    }

    case "elicitation_cancelled":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "elicitation_request" && m.requestId === event.requestId
            ? { ...m, kind: "status", role: "system", text: "elicitation cancelled" }
            : m,
        ),
      };

    case "structured_output": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "system",
        kind: "structured_output",
        payload: event.payload,
        source: "live",
      };
      return { ...state, messages: [...state.messages, message] };
    }

    case "plan_mode_changed": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "system",
        kind: "status",
        text: `mode → ${event.mode}`,
        source: "live",
      };
      return { ...state, messages: [...state.messages, message] };
    }

    case "turn_completed": {
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "system",
        kind: "complete",
        usage: event.usage,
        finishReason: event.finishReason,
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: undefined,
        currentThinkingId: undefined,
      };
    }

    case "agent_status": {
      const isErrorStatus = isErrorAgentStatusEvent(event);
      if (!isErrorStatus && !STATUS_AGENT_STATUS_EVENTS.has(event.event)) {
        return state;
      }
      const detail = event.detail ?? {};
      const kind = isErrorStatus ? "error" : "status";
      const text = typeof detail.message === "string" && detail.message.length > 0
        ? detail.message
        : kind === "error"
          ? "The model stream ended unexpectedly, so the response may be incomplete."
          : "This turn ended before producing a standard assistant response.";
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: kind === "error" ? "error" : "system",
        kind,
        text,
        ...(isI18nDescriptor(detail.messageI18n) ? { contentI18n: detail.messageI18n } : {}),
        ...(isI18nDescriptor(detail.userHintI18n) ? { userHintI18n: detail.userHintI18n } : {}),
        payload: {
          event: event.event,
          detail,
          ...(typeof detail.userHint === "string" ? { userHint: detail.userHint } : {}),
          ...(isI18nDescriptor(detail.messageI18n) ? { contentI18n: detail.messageI18n } : {}),
          ...(isI18nDescriptor(detail.userHintI18n) ? { userHintI18n: detail.userHintI18n } : {}),
        },
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: undefined,
        currentThinkingId: undefined,
        hasVisibleFailureStatus: state.hasVisibleFailureStatus
          || (kind === "error" && detail.visible !== false),
      };
    }

    case "error": {
      if (state.hasVisibleFailureStatus) {
        return {
          ...state,
          currentAssistantId: undefined,
          currentThinkingId: undefined,
        };
      }
      const id = newId();
      const message: WebMessage = {
        id,
        sessionKey: options.sessionKey,
        projectKey: options.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "error",
        kind: "error",
        text: event.message,
        payload: {
          code: event.code,
          recoverable: event.recoverable,
          ...(event.userHint ? { userHint: event.userHint } : {}),
        },
        source: "live",
      };
      return {
        ...state,
        messages: [...state.messages, message],
        currentAssistantId: undefined,
        currentThinkingId: undefined,
      };
    }
  }

  return state;
}

function defaultNewId(): string {
  // Browsers + Node 25 both expose `crypto.randomUUID`.
  const c =
    typeof globalThis !== "undefined" && (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return `web-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function isI18nDescriptor(value: unknown): value is { key: string; params?: Record<string, unknown> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { key?: unknown }).key === "string";
}

function isErrorAgentStatusEvent(event: WebGatewayEvent & { type: "agent_status" }): boolean {
  return ERROR_AGENT_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail);
}
