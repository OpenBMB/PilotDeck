import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { networkFetchJson, networkPostJson } from "../../network/fetch.js";
import type {
  GroupChatInvocation,
  StaffDeckEmployeeSummary,
} from "../protocol/types.js";

type StaffDeckAgentProfile = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  is_overall?: unknown;
  metadata?: unknown;
};

type StaffDeckListResponse = {
  data?: unknown;
  next_cursor?: unknown;
};

type StaffDeckSessionResponse = {
  id?: unknown;
};

type StaffDeckRunJob = {
  id?: unknown;
  status?: unknown;
  error?: unknown;
};

type StaffDeckRunResult = {
  reply?: unknown;
  session_id?: unknown;
  awaiting_input?: unknown;
};

type StaffDeckLegacyTurnResponse = {
  reply?: unknown;
  session_id?: unknown;
};

type StaffDeckLoginResponse = {
  access_token?: unknown;
  token?: unknown;
};

export type StaffDeckOpenApiConnection = {
  protocol: "open_api_v1";
  /** Complete Open API base, ending in /api/v1. */
  baseUrl: string;
  apiKey: string;
};

export type StaffDeckLegacyConnection = {
  protocol: "legacy_chat";
  baseUrl: string;
  tenantId: string;
  token?: string;
  username?: string;
  password?: string;
};

export type StaffDeckConnection = StaffDeckOpenApiConnection | StaffDeckLegacyConnection;

export type StaffDeckClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export class StaffDeckClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sessions = new Map<string, string>();
  private readonly legacyTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly legacyActivatedEmployees = new Set<string>();

  constructor(options: StaffDeckClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1_000);
  }

  resolveConnection(env: NodeJS.ProcessEnv): StaffDeckConnection | undefined {
    const configuredBaseUrl = env.STAFFDECK_BASE_URL?.trim();
    if (!configuredBaseUrl) return undefined;

    const tenantId = env.STAFFDECK_TENANT_ID?.trim();
    const legacyToken = env.STAFFDECK_API_TOKEN?.trim();
    const username = env.STAFFDECK_USERNAME?.trim();
    const password = env.STAFFDECK_PASSWORD;
    if (tenantId && username && password) {
      return {
        protocol: "legacy_chat",
        baseUrl: configuredBaseUrl.replace(/\/$/u, ""),
        tenantId,
        username,
        password,
      };
    }
    const apiKey = env.STAFFDECK_API_KEY?.trim() || (!tenantId ? legacyToken : undefined);
    if (apiKey) {
      return {
        protocol: "open_api_v1",
        baseUrl: normalizeOpenApiBaseUrl(configuredBaseUrl),
        apiKey,
      };
    }
    if (!tenantId) return undefined;
    return {
      protocol: "legacy_chat",
      baseUrl: configuredBaseUrl.replace(/\/$/u, ""),
      tenantId,
      token: legacyToken || undefined,
    };
  }

  async listEmployees(
    connection: StaffDeckConnection,
    signal?: AbortSignal,
  ): Promise<StaffDeckEmployeeSummary[]> {
    if (connection.protocol === "legacy_chat") {
      return this.listLegacyEmployees(connection, signal);
    }
    const { json } = await networkFetchJson<StaffDeckListResponse>(
      new URL(`${connection.baseUrl}/agents`),
      { headers: openApiHeaders(connection.apiKey) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        retry: { maxRetries: 1 },
      },
    );
    const values = Array.isArray(json.data) ? json.data : [];
    return normalizeEmployees(values);
  }

  async invoke(
    invocation: GroupChatInvocation,
    prompt: string,
    connection: StaffDeckConnection,
    signal?: AbortSignal,
  ): Promise<string> {
    const agentId = invocation.participant.employeeId;
    if (!agentId) throw new Error("StaffDeck participant is missing employeeId.");
    if (connection.protocol === "legacy_chat") {
      return this.invokeLegacy(invocation, prompt, connection, signal);
    }

    const sessionKey = `${invocation.room.id}:${invocation.participant.id}`;
    const sessionId = await this.ensureOpenApiSession(
      invocation,
      agentId,
      sessionKey,
      connection,
      signal,
    );
    const runIdempotencyKey = idempotencyKey(
      "run",
      `${sessionKey}:${invocation.sourceMessage.id}:${prompt}`,
    );
    const attachmentPayload = await staffDeckRunAttachments(invocation.attachments);
    const { json: createdRun } = await networkPostJson<StaffDeckRunJob>(
      new URL(`${connection.baseUrl}/agents/${encodeURIComponent(agentId)}/runs`),
      {
        input: `${prompt}${attachmentPayload.promptContext}`,
        session_id: sessionId,
        session_mode: "stateful",
        ...(attachmentPayload.attachments.length > 0
          ? { attachments: attachmentPayload.attachments }
          : {}),
        metadata: {
          channel: "pilotdeck_group_chat",
          room_id: invocation.room.id,
          participant_id: invocation.participant.id,
          source_message_id: invocation.sourceMessage.id,
        },
      },
      {
        headers: openApiHeaders(connection.apiKey, {
          "Idempotency-Key": runIdempotencyKey,
          "X-Request-ID": runIdempotencyKey,
        }),
      },
      {
        expectedStatuses: [200, 202],
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        retry: { maxRetries: 1, retryOnPost: true },
      },
    );
    const runId = requiredResponseId(createdRun.id, "StaffDeck run");
    const result = await this.waitForOpenApiResult(runId, connection, signal, createdRun);
    if (typeof result.session_id === "string" && result.session_id.trim()) {
      this.sessions.set(sessionKey, result.session_id.trim());
    }
    const reply = typeof result.reply === "string" ? result.reply.trim() : "";
    if (reply) return reply;
    const awaitingInput = formatAwaitingInput(result.awaiting_input);
    if (awaitingInput) return `StaffDeck 员工需要补充信息：${awaitingInput}`;
    throw new Error("StaffDeck employee returned an empty response.");
  }

  private async ensureOpenApiSession(
    invocation: GroupChatInvocation,
    agentId: string,
    sessionKey: string,
    connection: StaffDeckOpenApiConnection,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const externalSessionId = externalSessionKey(sessionKey);
    const sessionIdempotencyKey = idempotencyKey("session", sessionKey);
    const { json } = await networkPostJson<StaffDeckSessionResponse>(
      new URL(`${connection.baseUrl}/agents/${encodeURIComponent(agentId)}/sessions`),
      {
        external_session_id: externalSessionId,
        title: `PilotDeck · ${invocation.room.title}`.slice(0, 200),
        metadata: {
          channel: "pilotdeck_group_chat",
          room_id: invocation.room.id,
          participant_id: invocation.participant.id,
        },
      },
      {
        headers: openApiHeaders(connection.apiKey, {
          "Idempotency-Key": sessionIdempotencyKey,
          "X-Request-ID": sessionIdempotencyKey,
        }),
      },
      {
        expectedStatuses: [200, 201],
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        retry: { maxRetries: 1, retryOnPost: true },
      },
    );
    const sessionId = requiredResponseId(json.id, "StaffDeck session");
    this.sessions.set(sessionKey, sessionId);
    return sessionId;
  }

  private async waitForOpenApiResult(
    runId: string,
    connection: StaffDeckOpenApiConnection,
    signal: AbortSignal | undefined,
    initial: StaffDeckRunJob,
  ): Promise<StaffDeckRunResult> {
    const startedAt = Date.now();
    let job = initial;
    while (true) {
      const status = typeof job.status === "string" ? job.status : "";
      if (status === "succeeded" || status === "awaiting_input") {
        const { json } = await networkFetchJson<StaffDeckRunResult>(
          new URL(`${connection.baseUrl}/runs/${encodeURIComponent(runId)}/result`),
          { headers: openApiHeaders(connection.apiKey) },
          {
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: Math.min(this.timeoutMs, 30_000),
            retry: { maxRetries: 2, baseDelayMs: 250 },
          },
        );
        return json;
      }
      if (status === "failed") {
        throw new Error(`StaffDeck run ${runId} failed: ${formatRunError(job.error)}`);
      }
      if (status === "cancelled") throw new Error("StaffDeck run was cancelled.");

      const elapsed = Date.now() - startedAt;
      if (elapsed >= this.timeoutMs) {
        throw new Error(`StaffDeck run timed out after ${this.timeoutMs}ms.`);
      }
      await abortableDelay(Math.min(this.pollIntervalMs, this.timeoutMs - elapsed), signal);
      const { json } = await networkFetchJson<StaffDeckRunJob>(
        new URL(`${connection.baseUrl}/runs/${encodeURIComponent(runId)}`),
        { headers: openApiHeaders(connection.apiKey) },
        {
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: Math.min(this.timeoutMs - elapsed, 30_000),
          retry: { maxRetries: 1 },
        },
      );
      job = json;
    }
  }

  private async listLegacyEmployees(
    connection: StaffDeckLegacyConnection,
    signal?: AbortSignal,
  ): Promise<StaffDeckEmployeeSummary[]> {
    const token = await this.resolveLegacyToken(connection, signal);
    const url = new URL("/api/enterprise/agents", `${connection.baseUrl}/`);
    url.searchParams.set("tenant_id", connection.tenantId);
    const { json } = await networkFetchJson<StaffDeckAgentProfile[]>(
      url,
      { headers: legacyAuthHeaders(token) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.timeoutMs,
        retry: { maxRetries: 1 },
      },
    );
    if (!Array.isArray(json)) throw new Error("StaffDeck employee list response is not an array.");
    return normalizeEmployees(json, connection.username);
  }

  private async invokeLegacy(
    invocation: GroupChatInvocation,
    prompt: string,
    connection: StaffDeckLegacyConnection,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = await this.resolveLegacyToken(connection, signal);
    const agentId = invocation.participant.employeeId;
    if (!agentId) throw new Error("StaffDeck participant is missing employeeId.");
    await this.ensureLegacyEmployeeActivated(connection, token, agentId, signal);
    const sessionKey = `${invocation.room.id}:${invocation.participant.id}`;
    const existingSessionId = this.sessions.get(sessionKey);
    const { json } = await networkPostJson<StaffDeckLegacyTurnResponse>(
      new URL("/api/chat/turn", `${connection.baseUrl}/`),
      {
        tenant_id: connection.tenantId,
        agent_id: agentId,
        ...(existingSessionId ? { session_id: existingSessionId } : {}),
        channel: "pilotdeck_group_chat",
        message: prompt,
      },
      { headers: legacyAuthHeaders(token) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.timeoutMs,
        retry: { maxRetries: 0 },
      },
    );
    if (typeof json.session_id === "string" && json.session_id.trim()) {
      this.sessions.set(sessionKey, json.session_id.trim());
    }
    const reply = typeof json.reply === "string" ? json.reply.trim() : "";
    if (!reply) throw new Error("StaffDeck employee returned an empty response.");
    return reply;
  }

  private async ensureLegacyEmployeeActivated(
    connection: StaffDeckLegacyConnection,
    token: string | undefined,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const actor = connection.username || (token ? digest(token).slice(0, 16) : "anonymous");
    const cacheKey = `${connection.baseUrl}:${connection.tenantId}:${actor}:${agentId}`;
    if (this.legacyActivatedEmployees.has(cacheKey)) return;
    const url = new URL(`/api/chat/agents/${encodeURIComponent(agentId)}/use`, `${connection.baseUrl}/`);
    url.searchParams.set("tenant_id", connection.tenantId);
    await networkPostJson<StaffDeckAgentProfile>(
      url,
      {},
      { headers: legacyAuthHeaders(token) },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        retry: { maxRetries: 1 },
      },
    );
    this.legacyActivatedEmployees.add(cacheKey);
  }

  private async resolveLegacyToken(
    connection: StaffDeckLegacyConnection,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!connection.username || !connection.password) return connection.token;
    const cacheKey = `${connection.baseUrl}:${connection.tenantId}:${connection.username}`;
    const cached = this.legacyTokens.get(cacheKey);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const { json } = await networkPostJson<StaffDeckLoginResponse>(
      new URL("/api/auth/login", `${connection.baseUrl}/`),
      {
        tenant_id: connection.tenantId,
        username: connection.username,
        password: connection.password,
      },
      {},
      {
        expectedStatuses: [200],
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        retry: { maxRetries: 0 },
      },
    );
    const token = typeof json.access_token === "string" && json.access_token.trim()
      ? json.access_token.trim()
      : typeof json.token === "string" && json.token.trim()
        ? json.token.trim()
        : "";
    if (!token) throw new Error("StaffDeck login response is missing an access token.");
    this.legacyTokens.set(cacheKey, {
      token,
      expiresAt: jwtExpiresAt(token) ?? Date.now() + 30 * 60_000,
    });
    return token;
  }
}

const STAFFDECK_INLINE_IMAGE_LIMIT_BYTES = 4 * 1024 * 1024;
const STAFFDECK_TEXT_ATTACHMENT_LIMIT_CHARS = 24_000;
const STAFFDECK_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log",
  ".xml", ".html", ".htm", ".yaml", ".yml", ".js", ".jsx", ".ts", ".tsx",
  ".py", ".java", ".go", ".rs", ".sql", ".sh", ".zsh", ".toml", ".ini",
]);

async function staffDeckRunAttachments(
  attachments: GroupChatInvocation["attachments"],
): Promise<{ attachments: Array<Record<string, unknown>>; promptContext: string }> {
  if (!attachments?.length) return { attachments: [], promptContext: "" };
  const prepared = await Promise.all(attachments.map(async (attachment) => {
    const bytes = attachment.content
      ? Buffer.from(attachment.content, "base64")
      : attachment.path
        ? await readFile(attachment.path)
        : undefined;
    if (!bytes) throw new Error(`StaffDeck attachment ${attachment.name} has no readable content.`);
    const contentType = attachment.mimeType?.trim() || attachmentContentType(attachment.name, attachment.type);
    const id = `file_pd_${digest(`${attachment.name}:${contentType}:${bytes.length}:${digest(bytes.toString("base64"))}`).slice(0, 24)}`;
    if (attachment.type === "image") {
      if (bytes.length > STAFFDECK_INLINE_IMAGE_LIMIT_BYTES) {
        throw new Error(`图片“${attachment.name}”超过 StaffDeck 4 MB 内联图片限制。`);
      }
      if (!contentType.startsWith("image/")) {
        throw new Error(`图片“${attachment.name}”缺少有效的图片 MIME 类型。`);
      }
      return {
        promptContext: "",
        apiAttachment: {
          id,
          filename: attachment.name,
          content_type: contentType,
          size: bytes.length,
          kind: "image",
          preview: "图片由 PilotDeck 群组消息转发。",
          data_url: `data:${contentType};base64,${bytes.toString("base64")}`,
        },
      };
    }
    if (!isReadableTextAttachment(attachment.name, contentType)) {
      throw new Error(`StaffDeck Open API 暂不支持转发二进制附件“${attachment.name}”；请改用图片或文本文件。`);
    }
    const text = bytes.toString("utf8").slice(0, STAFFDECK_TEXT_ATTACHMENT_LIMIT_CHARS);
    return {
      promptContext: `\n\n<staffdeck_text_attachment name=${JSON.stringify(attachment.name)} content_type=${JSON.stringify(contentType)}>\n${text}\n</staffdeck_text_attachment>`,
      apiAttachment: {
        id,
        filename: attachment.name,
        content_type: contentType,
        size: bytes.length,
        kind: "text",
        text,
        preview: text.slice(0, 600),
      },
    };
  }));
  return {
    attachments: prepared.map((entry) => entry.apiAttachment),
    promptContext: prepared.map((entry) => entry.promptContext).join(""),
  };
}

function isReadableTextAttachment(name: string, contentType: string): boolean {
  return contentType.startsWith("text/")
    || ["application/json", "application/xml", "application/javascript", "application/x-yaml"].includes(contentType)
    || STAFFDECK_TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function attachmentContentType(name: string, type: "image" | "file"): string {
  const extension = extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".yaml": "application/x-yaml",
    ".yml": "application/x-yaml",
  };
  return known[extension] || (type === "image" ? "image/png" : "application/octet-stream");
}

function normalizeEmployees(
  values: unknown[],
  currentUsername?: string,
): StaffDeckEmployeeSummary[] {
  return values.flatMap((value): StaffDeckEmployeeSummary[] => {
    if (!value || typeof value !== "object") return [];
    const profile = value as StaffDeckAgentProfile;
    const id = typeof profile.id === "string" ? profile.id.trim() : "";
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const status = typeof profile.status === "string" ? profile.status.trim().toLowerCase() : "";
    if (!id || !name || status === "archived" || profile.is_overall === true) return [];
    const metadata = isRecord(profile.metadata) ? profile.metadata : {};
    const creatorUserId = firstMetadataString(metadata, "created_by_user_id", "owner_user_id");
    const creatorUsername = firstMetadataString(
      metadata,
      "created_by_username",
      "owner_username",
      "created_by",
      "creator_name",
    );
    const creatorDisplayName = firstMetadataString(
      metadata,
      "created_by_display_name",
      "owner_display_name",
      "creator_name",
      "created_by_username",
    );
    const publishedToGallery = metadata.published_to_gallery === true;
    const owned = Boolean(currentUsername && creatorUsername
      && creatorUsername.localeCompare(currentUsername, undefined, { sensitivity: "accent" }) === 0);
    const description = typeof profile.description === "string" && profile.description.trim()
      ? profile.description.trim()
      : undefined;
    const usedByCurrentUser = typeof metadata.used_by_current_user === "boolean"
      ? metadata.used_by_current_user
      : undefined;
    const roleName = firstMetadataString(metadata, "role_name");
    const expertiseTags = metadataStringArray(metadata.expertise_tags);
    const workStyles = metadataStringArray(metadata.work_styles);
    const workModes = metadataStringArray(metadata.work_modes);
    return [{
      id,
      name,
      ...(description ? { description } : {}),
      source: "staffdeck",
      access: owned ? "owned" : publishedToGallery ? "public" : "accessible",
      ...(creatorUserId ? { creatorUserId } : {}),
      ...(creatorUsername ? { creatorUsername } : {}),
      ...(creatorDisplayName ? { creatorDisplayName } : {}),
      publishedToGallery,
      ...(usedByCurrentUser !== undefined ? { usedByCurrentUser } : {}),
      ...(roleName ? { roleName } : {}),
      ...(expertiseTags ? { expertiseTags } : {}),
      ...(workStyles ? { workStyles } : {}),
      ...(workModes ? { workModes } : {}),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstMetadataString(metadata: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim()))];
  return items.length > 0 ? items : undefined;
}

function jwtExpiresAt(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp)
      ? parsed.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOpenApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("STAFFDECK_BASE_URL must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("STAFFDECK_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("STAFFDECK_BASE_URL must not embed credentials.");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/api/v1") ? path : `${path}/api/v1`.replace(/^\/+/u, "/");
  return url.toString().replace(/\/$/u, "");
}

function openApiHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

function legacyAuthHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function requiredResponseId(value: unknown, resource: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`${resource} response is missing id.`);
  return id;
}

function externalSessionKey(value: string): string {
  const readable = `pilotdeck:${value}`;
  return readable.length <= 200 ? readable : `pilotdeck:${digest(value)}`;
}

function idempotencyKey(kind: string, value: string): string {
  return `pilotdeck-${kind}-${digest(value).slice(0, 40)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatRunError(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const error = value as { detail?: unknown; message?: unknown; code?: unknown };
    const parts = [error.code, error.message, error.detail]
      .filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))
      .map((candidate) => candidate.trim());
    if (parts.length > 0) return [...new Set(parts)].join(": ");
  }
  return "unknown StaffDeck execution error";
}

function formatAwaitingInput(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const input = value as { prompt?: unknown; message?: unknown; question?: unknown };
  const text = [input.prompt, input.message, input.question]
    .find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof text === "string" ? text.trim() : "";
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("StaffDeck request aborted."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("StaffDeck request aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
