/**
 * Browser-friendly mirror of `src/gateway/protocol/types.ts` and
 * `src/gateway/protocol/frames.ts`.
 *
 * The browser bundle cannot import `src/gateway/protocol/types.ts` directly
 * because that file imports from `src/agent`, `src/cron`, `src/session`,
 * `src/tool` etc. (Node-only). This module copies the minimal shape needed
 * for the Web UI and is asserted against the canonical types via
 * `tests/web-ui-client/protocol-sync.test.ts`.
 */

export const PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB = "1.1";

export type WebGatewayMode =
  | "default"
  | "plan"
  | "bypassPermissions";

export type WebAgentRunMode =
  | "agent"
  | "plan"
  | "ask";

export type WebGatewayChannelKey =
  | "cli"
  | "tui"
  | "feishu"
  | "web"
  | "test"
  | (string & {});

export type WebElicitationQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect?: boolean;
};

export type WebElicitationAnswer =
  | { type: "answered"; answers: Record<string, string | string[]>; annotations?: Record<string, { preview?: string; notes?: string }> }
  | { type: "cancelled"; reason?: string };

type WebGatewayEventMetadata = {
  runId?: string;
};

export type WebGatewayEvent = WebGatewayEventMetadata & (
  | { type: "turn_started"; runId: string }
  | { type: "input_accepted"; runId: string }
  | { type: "steer_applied"; itemId: string; message: import("../../model/index.js").CanonicalMessage }
  | { type: "steer_unapplied"; itemId: string; reason: "turn_ended" }
  | { type: "model_selection_changed"; provider: string; model: string; source: "turn" | "session" | "router" | "default"; reasoning?: number; temperature?: number; speed?: number }
  | { type: "assistant_text_delta"; text: string }
  | { type: "assistant_thinking_delta"; text: string }
  | { type: "file_artifacts"; artifacts: import("../../session/artifacts/FileArtifact.js").FileArtifact[] }
  | {
      type: "tool_call_started";
      toolCallId: string;
      name: string;
      argsPreview?: string;
    }
  | {
      type: "tool_call_finished";
      toolCallId: string;
      ok: boolean;
      resultPreview?: string;
      /** Mirrors `GatewayEvent.tool_call_finished.errorCode`. */
      errorCode?: string;
      /**
       * Mirrors `GatewayEvent.tool_call_finished.images` — inline image
       * results (e.g. `read_file` on a PNG) surfaced to web clients so
       * they render alongside the tool row instead of in a stray
       * user-side bubble. Base64 payloads stay raw; the web reducer
       * wraps them as data URLs before they reach React state.
       */
      images?: Array<{
        mimeType: string;
        data: string;
        bytes?: number;
        detail?: "auto" | "low" | "high";
      }>;
    }
  | { type: "tool_result_detail_available"; toolCallId: string; resultPath?: string; fullText?: string }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      payload: unknown;
    }
  | {
      type: "elicitation_request";
      requestId: string;
      toolCallId: string;
      toolName: string;
      previewFormat?: "html" | "markdown";
      questions: WebElicitationQuestion[];
      metadata?: Record<string, unknown>;
    }
  | { type: "elicitation_cancelled"; requestId: string; reason?: string }
  | { type: "structured_output"; payload: unknown }
  | { type: "plan_mode_changed"; mode: WebGatewayMode | (string & {}) }
  | { type: "config_changed"; changedPaths: string[]; changeClasses: string[] }
  | { type: "worktree_created"; runId: string; cwd: string }
  | { type: "worktree_removed"; cwd: string }
  | { type: "agent_status"; event: string; detail?: Record<string, unknown> }
  | { type: "turn_completed"; usage: Record<string, number>; finishReason: string }
  | {
      type: "error";
      message: string;
      code?: string;
      recoverable: boolean;
      userHint?: string;
      providerError?: {
        provider?: string;
        protocol?: string;
        status?: number;
        code?: string;
        message?: string;
        raw?: string;
      };
    }
);

export type WebGatewayMethod =
  | "submit_turn"
  | "steer_turn"
  | "cancel_steer"
  | "abort_turn"
  | "list_sessions"
  | "resume_session"
  | "new_session"
  | "close_session"
  | "describe_server"
  | "project_files_list"
  | "commands_list"
  | "model_catalog_list"
  | "session_model_get"
  | "session_model_set"
  | "session_model_clear"
  | "active_turn_snapshot"
  | "cron_create"
  | "cron_list"
  | "cron_update"
  | "cron_delete"
  | "cron_stop"
  | "cron_run_now"
  | "elicitation_respond"
  | "permission_decide"
  | "grant_session_permission"
  | "read_session_messages"
  | "read_subagent_messages"
  | "fork_session"
  | "replace_last_turn"
  | "finalize_last_turn_replacement"
  | "rename_session"
  | "delete_session"
  | "list_projects"
  | "describe_project"
  | "reload_config"
  | "skill_list"
  | "skill_read"
  | "skill_write"
  | "skill_create"
  | "skill_delete"
  | "skill_import"
  | "skill_validate"
  | "skill_scan"
  | "always_on_apply"
  | "always_on_rerun_plan";

export type WebSubmitTurnInput = {
  sessionKey: string;
  channelKey: WebGatewayChannelKey;
  message: string;
  projectKey?: string;
  uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
  modelOverride?: WebExplicitModelSelection;
  attachments?: WebChannelAttachment[];
  runMode?: WebAgentRunMode;
  mode?: WebGatewayMode;
  basePermissionMode?: WebGatewayMode;
  /** Allow model-visible plan mode tools. Defaults to true only for explicit plan-mode turns. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  runId?: string;
  syntheticMessages?: Array<{ text: string; purpose?: string }>;
};

export type WebSteerTurnInput = {
  sessionKey: string;
  runId: string;
  itemId: string;
  message: string;
  projectKey?: string;
  attachments?: WebChannelAttachment[];
  uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
};

export type WebSteerTurnResult = {
  accepted: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "turn_closing" | "cancelled";
};

export type WebCancelSteerInput = {
  sessionKey: string;
  runId: string;
  itemId: string;
};

export type WebCancelSteerResult = {
  cancelled: boolean;
  reason?: "no_active_turn" | "turn_mismatch" | "too_late";
};

export type WebMatchRange = { field: string; start: number; end: number };
export type WebProjectFilesListInput = { projectKey: string; query?: string; cursor?: string; limit?: number; includeDirs?: boolean };
export type WebProjectFilesListResult = {
  projectKey: string;
  items: Array<{ id: string; name: string; relativePath: string; kind: "file" | "directory"; size: number; mtimeMs: number; matches?: WebMatchRange[] }>;
  nextCursor?: string;
};
export type WebCommandsListInput = { projectKey: string; query?: string; cursor?: string; limit?: number };
export type WebCommandsListResult = { pinned: unknown[]; builtIn: unknown[]; custom: unknown[]; nextCursor?: string };
export type WebExplicitModelSelection = { mode: "model"; provider: string; model: string; reasoning?: number; temperature?: number; speed?: number };
export type WebSessionModelSelection = { mode: "auto" } | WebExplicitModelSelection;
export type WebModelCatalogListInput = { projectKey: string; query?: string; provider?: string; includeAuto?: boolean };
export type WebModelCatalogListResult = { items: unknown[]; router: { enabled: boolean; autoAvailable: boolean } };
export type WebSessionModelInput = { projectKey: string; sessionKey: string };
export type WebSessionModelResult = WebSessionModelInput & { saved?: WebSessionModelSelection; effective: { provider: string; model: string; source: "session" | "router" | "default"; reasoning?: number; temperature?: number; speed?: number } };

export type WebChannelAttachment = {
  type: "file" | "image" | "text" | "unknown";
  name?: string;
  path?: string;
  mimeType?: string;
  content?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type WebSessionInfo = {
  sessionId: string;
  sessionKey?: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  sessionKind?: "background_task";
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  forkedFromTurnId?: string;
};

export type WebListSessionsInput = {
  projectKey?: string;
  limit?: number;
  cursor?: string;
};

export type WebListSessionsResult = {
  sessions: WebSessionInfo[];
  nextCursor?: string;
};

export type WebHelloOk = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: {
    mode: "in_process" | "remote";
    protocolVersion?: string;
    projectKey?: string;
    sessionCount?: number;
    capabilities?: Array<"project_files_list" | "commands_list" | "model_catalog_list" | "session_model_get" | "session_model_set" | "session_model_clear">;
  };
};

export type WebRequestFrame = {
  type: "request";
  id: string;
  method: WebGatewayMethod;
  params: unknown;
};

export type WebResponseFrame =
  | { type: "response"; id: string; ok: true; result: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string; details?: unknown };
    };

export type WebEventFrame = {
  type: "event";
  id: string;
  seq: number;
  final: boolean;
  event: WebGatewayEvent;
};

export type WebGatewayFrame =
  | WebHelloOk
  | WebResponseFrame
  | WebEventFrame;

export type WebPermissionDecision = {
  requestId: string;
  decision: "allow" | "deny";
  remember?: boolean;
  reason?: string;
};

export type WebSessionPermissionGrant = {
  sessionKey: string;
  entry: string;
};

export type WebReadSessionMessagesInput = {
  sessionKey: string;
  projectKey?: string;
  sessionKind?: "background_task";
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  limit?: number;
  cursor?: string;
  direction?: "forward" | "backward";
};

export type WebReadSessionMessagesResult = {
  messages: import("./webMessage.js").WebMessage[];
  nextCursor?: string;
  total?: number;
  tokenUsage?: Record<string, unknown>;
  session: WebSessionInfo;
};

export type WebReadSubagentMessagesInput = {
  sessionKey: string;
  subagentId: string;
  projectKey?: string;
  sessionKind?: "background_task";
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

export type WebReadSubagentMessagesResult = {
  messages: import("./webMessage.js").WebMessage[];
  total: number;
};

export type WebForkSessionInput = {
  sessionKey: string;
  projectKey?: string;
  /** Transcript entry id of the user turn to fork from (accepted_input entryId). */
  fromEntryId: string;
};

export type WebForkSessionResult = {
  newSessionKey: string;
  prefillText: string;
  carriedMessageCount: number;
  runMode?: WebAgentRunMode;
  mode?: WebGatewayMode;
};

export type WebReplaceLastTurnInput = {
  sessionKey: string;
  projectKey?: string;
  /** Guards against replacing a turn that is no longer the transcript tail. */
  expectedTurnId: string;
  /** The new turn that is allowed to consume this replacement transaction. */
  replacementTurnId: string;
};

export type WebReplaceLastTurnResult = {
  sessionKey: string;
  replacedTurnId: string;
  removedEntryCount: number;
  /** Opaque token used to commit or roll back the transcript rewrite. */
  transactionId: string;
};

export type WebFinalizeLastTurnReplacementInput = {
  sessionKey: string;
  projectKey?: string;
  transactionId: string;
  action: "commit" | "rollback";
};

export type WebFinalizeLastTurnReplacementResult = {
  sessionKey: string;
  transactionId: string;
  action: "commit" | "rollback";
};

export type WebActiveTurnSnapshotInput = {
  sessionKey: string;
  /** Defaults to true. Set false for status-only polling. */
  includeEvents?: boolean;
};

export type WebActiveTurnSnapshot = {
  active: boolean;
  sessionKey: string;
  runId?: string;
  events: WebGatewayEvent[];
  truncated?: boolean;
};

export type WebProjectSummary = {
  projectKey: string;
  name: string;
  fullPath: string;
  sessionCount: number;
  lastActivity?: number;
  createdAt?: number;
};

export type WebListProjectsResult = {
  projects: WebProjectSummary[];
};
