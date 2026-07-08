export type AgentStatusScope =
  | "turn"
  | "session"
  | "preflight"
  | "http"
  | "channel";

export type AgentStatusSource =
  | "agent"
  | "gateway"
  | "web_bridge"
  | "web_http"
  | "im_channel"
  | "api_server"
  | "webhook";

export type AgentStatusSeverity = "info" | "warning" | "error";

export type AgentStatusDetailInput = {
  message: string;
  code?: string;
  severity?: AgentStatusSeverity;
  visible?: boolean;
  userHint?: string;
  scope: AgentStatusScope;
  source: AgentStatusSource;
  detail?: Record<string, unknown>;
};

export type AgentStatusHttpErrorBody = {
  error: {
    message: string;
    type: string;
    code: string;
    userHint?: string;
    status?: number;
    scope: AgentStatusScope;
    source: AgentStatusSource;
    event: string;
  };
  agent_status: {
    type: "agent_status";
    event: string;
    detail: Record<string, unknown>;
  };
};

export function createAgentStatusDetail(input: AgentStatusDetailInput): Record<string, unknown> {
  return pruneUndefined({
    message: input.message,
    code: input.code,
    severity: input.severity,
    visible: input.visible ?? true,
    userHint: input.userHint,
    scope: input.scope,
    source: input.source,
    ...(input.detail ?? {}),
  });
}

export function createVisibleErrorStatusDetail(
  input: Omit<AgentStatusDetailInput, "severity" | "visible"> & {
    severity?: Extract<AgentStatusSeverity, "warning" | "error">;
    userHint: string;
  },
): Record<string, unknown> {
  return createAgentStatusDetail({
    ...input,
    severity: input.severity ?? "error",
    visible: true,
  });
}

export function createAgentStatusHttpErrorBody(input: {
  event: string;
  message: string;
  code?: string;
  status?: number;
  type?: string;
  userHint?: string;
  scope: AgentStatusScope;
  source: AgentStatusSource;
  detail?: Record<string, unknown>;
}): AgentStatusHttpErrorBody {
  const code = input.code ?? input.event;
  const userHint = input.userHint ?? defaultUserHintForHttpStatus(input.status);
  const detail = createVisibleErrorStatusDetail({
    message: input.message,
    code,
    userHint,
    scope: input.scope,
    source: input.source,
    detail: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.detail ?? {}),
    },
  });
  return {
    error: pruneUndefined({
      message: input.message,
      type: input.type ?? defaultHttpErrorType(input.status),
      code,
      userHint,
      status: input.status,
      scope: input.scope,
      source: input.source,
      event: input.event,
    }) as AgentStatusHttpErrorBody["error"],
    agent_status: {
      type: "agent_status",
      event: input.event,
      detail,
    },
  };
}

export function isVisibleFailureStatusDetail(detail: unknown): boolean {
  if (!isRecord(detail)) return false;
  return detail.visible !== false && detail.severity === "error";
}

export function visibleStatusMessage(detail: unknown, fallback: string): string {
  if (isRecord(detail) && typeof detail.message === "string" && detail.message.trim()) {
    return detail.message;
  }
  return fallback;
}

function defaultUserHintForHttpStatus(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "Check authentication and permissions, then retry.";
  }
  if (status === 429) {
    return "Wait for the rate limit to reset, then retry.";
  }
  if (status === 413) {
    return "Reduce the request size and retry.";
  }
  if (status !== undefined && status >= 500) {
    return "The server is unavailable or returned an internal error. Retry later or check server logs.";
  }
  return "Fix the request and retry.";
}

function defaultHttpErrorType(status: number | undefined): string {
  if (status === 429) return "rate_limit_error";
  if (status !== undefined && status >= 500) return "server_error";
  return "invalid_request_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
