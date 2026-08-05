import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { networkFetch, networkFetchJson, networkPostJson } from "../../network/fetch.js";
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
  task_results?: unknown;
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

export type StaffDeckRunStreamEvent = {
  type: string;
  id?: string;
  runId?: string;
  data: Record<string, unknown>;
  /** Current normalized reply after applying delta/replace semantics. */
  output?: string;
};

export type StaffDeckRunStreamHandler = (
  event: StaffDeckRunStreamEvent,
) => void | Promise<void>;

export class StaffDeckClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sessions = new Map<string, string>();
  private readonly sessionEpochs = new Map<string, number>();
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
    const explicitApiKey = env.STAFFDECK_API_KEY?.trim();
    // An explicitly configured Open API credential is an intentional protocol
    // selection. Prefer it even when legacy account fields remain in the local
    // config so runs:stream and its public execution trace are not bypassed.
    if (explicitApiKey) {
      return {
        protocol: "open_api_v1",
        baseUrl: normalizeOpenApiBaseUrl(configuredBaseUrl),
        apiKey: explicitApiKey,
      };
    }
    if (tenantId && username && password) {
      return {
        protocol: "legacy_chat",
        baseUrl: configuredBaseUrl.replace(/\/$/u, ""),
        tenantId,
        username,
        password,
      };
    }
    const apiKey = !tenantId ? legacyToken : undefined;
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
    onStreamEvent?: StaffDeckRunStreamHandler,
  ): Promise<string> {
    const agentId = invocation.participant.employeeId;
    if (!agentId) throw new Error("StaffDeck participant is missing employeeId.");
    if (connection.protocol === "legacy_chat") {
      return this.invokeLegacy(invocation, prompt, connection, signal);
    }

    const sessionKey = `${invocation.room.id}:${invocation.sourceMessage.conversationId || "default"}:${invocation.participant.id}`;
    try {
      const sessionId = await this.ensureOpenApiSession(
        invocation,
        agentId,
        sessionKey,
        connection,
        signal,
      );
      const runIdempotencyKey = idempotencyKey(
        "run",
        `${sessionKey}:${sessionId}:${invocation.sourceMessage.id}:${prompt}`,
      );
      const attachmentPayload = await staffDeckRunAttachments(invocation.attachments);
      const runInput = {
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
      };
      const runHeaders = openApiHeaders(connection.apiKey, {
        "Idempotency-Key": runIdempotencyKey,
        "X-Request-ID": runIdempotencyKey,
      });
      const streamedResult = await this.invokeOpenApiStream(
        agentId,
        runInput,
        runHeaders,
        connection,
        signal,
        onStreamEvent,
      );
      const result = streamedResult ?? await (async () => {
        const { json: createdRun } = await networkPostJson<StaffDeckRunJob>(
          new URL(`${connection.baseUrl}/agents/${encodeURIComponent(agentId)}/runs`),
          runInput,
          { headers: runHeaders },
          {
            expectedStatuses: [200, 202],
            fetchImpl: this.fetchImpl,
            signal,
            timeoutMs: Math.min(this.timeoutMs, 30_000),
            retry: { maxRetries: 1, retryOnPost: true },
          },
        );
        const runId = requiredResponseId(createdRun.id, "StaffDeck run");
        return this.waitForOpenApiResult(runId, connection, signal, createdRun);
      })();
      if (typeof result.session_id === "string" && result.session_id.trim()) {
        this.sessions.set(sessionKey, result.session_id.trim());
      }
      const reply = typeof result.reply === "string" ? result.reply.trim() : "";
      const runtimeFailure = staffDeckRuntimeFailure(reply, result.task_results);
      if (runtimeFailure) throw new Error(runtimeFailure);
      if (reply) return reply;
      const awaitingInput = formatAwaitingInput(result.awaiting_input);
      if (awaitingInput) return `StaffDeck 员工需要补充信息：${awaitingInput}`;
      throw new Error("StaffDeck employee returned an empty response.");
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("StaffDeck request aborted.");
      }
      if (isRecoverableSessionFailure(error)) {
        this.sessions.delete(sessionKey);
        this.sessionEpochs.set(sessionKey, (this.sessionEpochs.get(sessionKey) ?? 0) + 1);
      }
      throw error;
    }
  }

  private async invokeOpenApiStream(
    agentId: string,
    input: Record<string, unknown>,
    headers: Record<string, string>,
    connection: StaffDeckOpenApiConnection,
    signal?: AbortSignal,
    onStreamEvent?: StaffDeckRunStreamHandler,
  ): Promise<StaffDeckRunResult | undefined> {
    const controller = new AbortController();
    let runId: string | undefined;
    let cancellation: Promise<void> | undefined;
    const requestCancellation = () => {
      if (!runId) return undefined;
      cancellation ??= this.cancelOpenApiRun(runId, connection).catch(() => undefined);
      return cancellation;
    };
    const forwardAbort = () => {
      controller.abort(signal?.reason ?? new Error("StaffDeck request aborted."));
      void requestCancellation();
    };
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(new Error(`StaffDeck run timed out after ${this.timeoutMs}ms.`));
      // Cancellation must not depend on the response stream noticing AbortSignal.
      // Some stalled HTTP/SSE implementations keep the reader pending, while the
      // remote Run would otherwise continue occupying its stateful session.
      void requestCancellation();
    }, this.timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

    let response: Response;
    try {
      response = await networkFetch(
        new URL(`${connection.baseUrl}/agents/${encodeURIComponent(agentId)}/runs:stream`),
        {
          method: "POST",
          headers: {
            ...headers,
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
        {
          fetchImpl: this.fetchImpl,
          signal: controller.signal,
          timeoutMs: Math.min(this.timeoutMs, 30_000),
          retry: { maxRetries: 0, retryOnPost: false },
        },
      );
      if ([404, 405, 501].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(`StaffDeck stream HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      runId = response.headers.get("x-run-id")?.trim() || undefined;
      let output = "";
      let sessionId: string | undefined;
      let awaitingInput: unknown;
      let completed = false;
      let failure: string | undefined;
      await consumeSse(response.body, async ({ type, id, data }) => {
        if (controller.signal.aborted) return;
        const eventRunId = firstRecordString(data, "run_id", "job_id") || runId;
        sessionId = firstRecordString(data, "session_id") || sessionId;
        if (type === "run.output.delta") {
          output += streamOutputText(data);
        } else if (type === "run.output.replace") {
          output = streamOutputText(data);
        } else if (type === "run.output.completed") {
          const replacement = streamOutputText(data);
          if (replacement) output = replacement;
          completed = true;
        } else if (type === "run.awaiting_input") {
          awaitingInput = data.awaiting_input ?? data;
          completed = true;
        } else if (type === "run.failed") {
          failure = streamFailure(data);
        } else if (type === "run.cancelled") {
          failure = "StaffDeck run was cancelled.";
        }
        await onStreamEvent?.({
          type,
          ...(id ? { id } : {}),
          ...(eventRunId ? { runId: eventRunId } : {}),
          data,
          ...(type.startsWith("run.output.") ? { output } : {}),
        });
      });
      if (failure) throw new Error(failure);
      if (completed && (output.trim() || awaitingInput)) {
        return {
          reply: output.trim(),
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(awaitingInput ? { awaiting_input: awaitingInput } : {}),
        };
      }
      if (runId) {
        return await this.waitForOpenApiResult(runId, connection, controller.signal, {
          id: runId,
          status: "running",
        });
      }
      throw new Error("StaffDeck stream ended without a completed output or X-Run-ID header.");
    } catch (error) {
      if (controller.signal.aborted && runId) {
        void requestCancellation();
      }
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async cancelOpenApiRun(
    runId: string,
    connection: StaffDeckOpenApiConnection,
  ): Promise<void> {
    const response = await networkFetch(
      new URL(`${connection.baseUrl}/runs/${encodeURIComponent(runId)}:cancel`),
      {
        method: "POST",
        headers: openApiHeaders(connection.apiKey),
      },
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: Math.min(this.timeoutMs, 10_000),
        retry: { maxRetries: 0, retryOnPost: false },
      },
    );
    if (!response.ok) {
      throw new Error(`StaffDeck cancel HTTP ${response.status}.`);
    }
    await response.body?.cancel().catch(() => undefined);
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
    const epoch = this.sessionEpochs.get(sessionKey) ?? 0;
    const versionedSessionKey = `${sessionKey}:${epoch}`;
    const externalSessionId = externalSessionKey(versionedSessionKey);
    const sessionIdempotencyKey = idempotencyKey("session", versionedSessionKey);
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

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  consume: (event: { type: string; id?: string; data: Record<string, unknown> }) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeBlock = async (block: string) => {
    let type = "message";
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /u, "") : "";
      if (field === "event" && value) type = value;
      else if (field === "id" && value) id = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { text: raw };
    }
    await consume({
      type,
      ...(id ? { id } : {}),
      data: isRecord(parsed) ? parsed : { value: parsed },
    });
  };
  const flushBlocks = async (flush = false) => {
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/u);
      if (!separator || separator.index === undefined) break;
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      if (block.trim()) await consumeBlock(block);
    }
    if (flush && buffer.trim()) {
      const block = buffer;
      buffer = "";
      await consumeBlock(block);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await flushBlocks();
    }
    buffer += decoder.decode();
    await flushBlocks(true);
  } finally {
    reader.releaseLock();
  }
}

function firstRecordString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function streamOutputText(data: Record<string, unknown>): string {
  const direct = firstRecordText(data, "delta", "text", "reply", "content", "output");
  if (direct !== undefined) return direct;
  for (const key of ["data", "result", "message"]) {
    const nested = data[key];
    if (isRecord(nested)) {
      const value = firstRecordText(nested, "delta", "text", "reply", "content", "output");
      if (value !== undefined) return value;
    }
  }
  return "";
}

function firstRecordText(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function streamFailure(data: Record<string, unknown>): string {
  const code = firstRecordString(data, "code");
  const message = firstRecordString(data, "message", "detail", "error");
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `StaffDeck run failed: ${detail}` : "StaffDeck run failed.";
}

function staffDeckRuntimeFailure(reply: string, taskResults: unknown): string | undefined {
  const serialized = `${reply}\n${JSON.stringify(taskResults ?? [])}`;
  const markers = [
    ["HARNESS_TURN_CONFLICT", "StaffDeck 会话仍有任务在执行，已终止本次重复调用。"],
    ["SERVICE_RESTARTED", "StaffDeck 服务执行期间发生重启。"],
  ] as const;
  for (const [code, message] of markers) {
    if (serialized.includes(code)) return `StaffDeck run failed: ${code}: ${message}`;
  }
  return undefined;
}

function isRecoverableSessionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ["HARNESS_TURN_CONFLICT", "SERVICE_RESTARTED", "session busy"]
    .some((marker) => message.toLowerCase().includes(marker.toLowerCase()));
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
