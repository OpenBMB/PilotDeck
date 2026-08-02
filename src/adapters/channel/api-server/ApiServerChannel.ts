import { randomUUID, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { ApiServerSessionMapper } from "./ApiServerSessionMapper.js";
import { renderApiServerEvent } from "./api-server-render.js";
import {
  createAgentStatusHttpErrorBody,
  isVisibleFailureStatusDetail,
} from "../../../status/agentStatus.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8642;
const MAX_REQUEST_BYTES = 1_000_000;
const DEFAULT_MODEL_NAME = "pilotdeck-gateway";
const REQUEST_TIMEOUT_MS = 300_000;
const GROUP_READ_ONLY_DENY_RULES = [
  "bash", "write_file", "edit_file", "edit_notebook", "execute_code",
  "agent", "group_chat", "task_create", "task_stop", "todo_write", "mcp__*",
].map((toolName) => ({ source: "policy" as const, behavior: "deny" as const, toolName }));

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hermes-Session-Id",
  "Access-Control-Expose-Headers": "X-Hermes-Session-Id",
};

export type ApiServerChannelOptions = {
  port?: number;
  apiKey?: string;
  host?: string;
  modelName?: string;
  corsOrigins?: string | string[];
  mapper?: ApiServerSessionMapper;
  workspaceMappings?: Record<string, string>;
};

export class ApiServerChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "api_server";

  private readonly mapper: ApiServerSessionMapper;
  private readonly host: string;
  private readonly port: number;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly corsOrigins: string[];
  private readonly workspaceMappings: Record<string, string>;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private server: Server | null = null;
  private activeChats = new Set<string>();

  constructor(options: ApiServerChannelOptions = {}) {
    this.mapper = options.mapper ?? new ApiServerSessionMapper();
    this.host = options.host ?? process.env.API_SERVER_HOST ?? DEFAULT_HOST;
    this.port = Number(options.port ?? process.env.API_SERVER_PORT ?? DEFAULT_PORT);
    this.apiKey = options.apiKey ?? process.env.API_SERVER_KEY ?? "";
    this.modelName = options.modelName ?? process.env.API_SERVER_MODEL_NAME ?? DEFAULT_MODEL_NAME;
    this.corsOrigins = parseCorsOrigins(options.corsOrigins ?? process.env.API_SERVER_CORS_ORIGINS ?? "");
    this.workspaceMappings = options.workspaceMappings ?? parseWorkspaceMappings(process.env.PILOTDECK_WORKSPACE_MAPPINGS);
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    try {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, this.host, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      this.logger?.info?.(`api-server: listening on http://${this.host}:${this.port}`);
    } catch (e) {
      this.logger?.error?.(`api-server: failed to start: ${e}`);
      this.server = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`api-server: stopping (${reason ?? "no reason"})`);
        if (this.server) {
          await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
          });
          this.server = null;
        }
      },
    };
  }

  private getCorsHeaders(origin: string | null): Record<string, string> | null {
    if (!origin || this.corsOrigins.length === 0) return null;
    if (this.corsOrigins.includes("*")) {
      return { ...CORS_HEADERS, "Access-Control-Allow-Origin": "*" };
    }
    if (this.corsOrigins.includes(origin)) {
      return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    }
    return null;
  }

  private applyCors(res: ServerResponse, cors: Record<string, string> | null): void {
    if (!cors) return;
    for (const [k, v] of Object.entries(cors)) {
      res.setHeader(k, v);
    }
  }

  private checkAuth(req: IncomingMessage): { ok: true } | { ok: false; status: number; body: unknown } {
    if (!this.apiKey) return { ok: true };
    const auth = String(req.headers["authorization"] ?? "");
    if (auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      try {
        const a = Buffer.from(token);
        const b = Buffer.from(this.apiKey);
        if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
      } catch {
        // fallthrough
      }
    }
    return {
      ok: false,
      status: 401,
      body: createApiServerErrorBody({
        event: "api_auth_failed",
        message: "Invalid API key",
        code: "invalid_api_key",
        status: 401,
        userHint: "Check the API key and retry.",
      }),
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);
    const origin = (req.headers["origin"] as string | undefined) ?? null;
    const cors = this.getCorsHeaders(origin);

    if (req.method === "OPTIONS") {
      this.applyCors(res, cors);
      res.statusCode = 204;
      res.end();
      return;
    }

    this.applyCors(res, cors);

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        platform: "api-server",
        version: 1,
        capabilities: { groupTurn: Boolean(this.apiKey), delegation: Boolean(this.apiKey) },
      });
      return;
    }

    if (url.pathname === "/v1/models") {
      const auth = this.checkAuth(req);
      if (!auth.ok) {
        sendJson(res, auth.status, auth.body);
        return;
      }
      sendJson(res, 200, {
        object: "list",
        version: 1,
        capabilities: { groupTurn: Boolean(this.apiKey), delegation: Boolean(this.apiKey) },
        workspaceKeys: Object.keys(this.workspaceMappings).sort(),
        data: [
          {
            id: this.modelName,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "gateway",
          },
        ],
      });
      return;
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const auth = this.checkAuth(req);
      if (!auth.ok) {
        sendJson(res, auth.status, auth.body);
        return;
      }
      await this.handleChatCompletions(req, res);
      return;
    }

    if (url.pathname === "/v1/group/turn" && req.method === "POST") {
      if (!this.apiKey) {
        sendJson(res, 503, { error: "Group-turn API requires API_SERVER_KEY to be configured." });
        return;
      }
      const auth = this.checkAuth(req);
      if (!auth.ok) {
        sendJson(res, auth.status, auth.body);
        return;
      }
      await this.handleGroupTurn(req, res);
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  }

  private async handleGroupTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.gateway) {
      sendJson(res, 503, { error: "Gateway not ready." });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readRequestBody(req, MAX_REQUEST_BYTES)) as Record<string, unknown>;
    } catch (error) {
      sendJson(res, 400, { error: `Invalid group-turn request: ${String(error)}` });
      return;
    }
    if (body.version !== 1) {
      sendJson(res, 400, { error: "Unsupported group-turn version." });
      return;
    }
    const roomId = safeStableId(body.roomId);
    const roundId = safeStableId(body.roundId);
    const entryMemberId = safeStableId(body.entryMemberId);
    const workspaceKey = typeof body.workspaceKey === "string" ? body.workspaceKey.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!roomId || !roundId || !entryMemberId || !workspaceKey || !message) {
      sendJson(res, 400, { error: "roomId, roundId, entryMemberId, workspaceKey and message are required." });
      return;
    }
    const workspace = this.workspaceMappings[workspaceKey];
    if (!workspace) {
      sendJson(res, 404, { error: "Workspace mapping not found." });
      return;
    }
    const projectKey = resolve(workspace);
    const idempotencyKey = `${roomId}:${roundId}:${entryMemberId}`;
    const cached = await readGroupTurnCache(idempotencyKey);
    if (cached) {
      writeNdjsonEvents(res, cached, true);
      return;
    }
    if (this.activeChats.has(idempotencyKey)) {
      sendJson(res, 409, { error: "This group turn is already running.", code: "turn_in_progress" });
      return;
    }
    const rosterContext = typeof body.rosterContext === "string" ? body.rosterContext.slice(0, 100_000) : "";
    const requiredDelegates = Array.isArray(body.requiredDelegates)
      ? body.requiredDelegates.filter((value): value is string => typeof value === "string").slice(0, 32)
      : [];
    const collaborationBody = body.collaboration && typeof body.collaboration === "object"
      ? body.collaboration as Record<string, unknown>
      : {};
    const collaboration = {
      version: 1 as const,
      kind: "group_turn" as const,
      roomId,
      turnId: roundId,
      entryMemberId,
      canDelegate: collaborationBody.canDelegate === true,
      ...(typeof collaborationBody.coordinatorUrl === "string" ? { coordinatorUrl: collaborationBody.coordinatorUrl } : {}),
      ...(typeof collaborationBody.delegationToken === "string" ? { delegationToken: collaborationBody.delegationToken } : {}),
    };
    const sessionKey = `group:${roomId}:${entryMemberId}`;
    const events: GatewayEvent[] = [];
    this.activeChats.add(idempotencyKey);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    res.flushHeaders?.();
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "api_server",
        projectKey,
        workspaceCwd: projectKey,
        message,
        runMode: "ask",
        mode: "default",
        canPrompt: false,
        permissionRules: { deny: GROUP_READ_ONLY_DENY_RULES },
        timeoutMs: REQUEST_TIMEOUT_MS,
        collaboration,
        syntheticMessages: rosterContext ? [{ purpose: "group_chat_context", text: [
          rosterContext,
          requiredDelegates.length > 0
            ? `You must delegate to these member ids in order: ${requiredDelegates.join(" -> ")}.`
            : "",
        ].filter(Boolean).join("\n") }] : undefined,
      })) {
        events.push(event);
        res.write(`${JSON.stringify(event)}\n`);
      }
      await writeGroupTurnCache(idempotencyKey, events);
      res.write(`${JSON.stringify({ type: "group_turn_stream_end", cached: false })}\n`);
    } catch (error) {
      const failure = { type: "error", code: "group_turn_failed", message: String(error), recoverable: false };
      events.push(failure as GatewayEvent);
      res.write(`${JSON.stringify(failure)}\n`);
    } finally {
      this.activeChats.delete(idempotencyKey);
      res.end();
    }
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, MAX_REQUEST_BYTES);
    } catch (e) {
      sendJson(res, 413, createApiServerErrorBody({
        event: "api_request_too_large",
        message: `Request too large or unreadable: ${e}`,
        code: "request_too_large",
        status: 413,
        userHint: "Reduce the request size and retry.",
      }));
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, createApiServerErrorBody({
        event: "api_invalid_json",
        message: "Invalid JSON",
        code: "invalid_json",
        status: 400,
        userHint: "Send a valid JSON request body.",
      }));
      return;
    }

    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, createApiServerErrorBody({
        event: "api_messages_required",
        message: "messages is required",
        code: "messages_required",
        status: 400,
        userHint: "Send at least one chat message.",
      }));
      return;
    }

    const lastMsg = messages[messages.length - 1];
    const userText = normalizeContent(lastMsg?.content);
    if (!userText) {
      sendJson(res, 400, createApiServerErrorBody({
        event: "api_empty_message",
        message: "Empty message",
        code: "empty_message",
        status: 400,
        userHint: "Send a non-empty user message.",
      }));
      return;
    }

    const sessionIdHeader = String(req.headers["x-hermes-session-id"] ?? "").trim();
    const chatId = sessionIdHeader || `api-${randomUUID()}`;
    const streaming = body.stream === true;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`api-server: chat ${chatId} already active, rejecting`);
      sendJson(res, 429, createApiServerErrorBody({
        event: "session_busy",
        message: "Session already processing a request",
        code: "session_busy",
        status: 429,
        type: "rate_limit_error",
        scope: "session",
        userHint: "Wait for the current request to finish or start a new session.",
      }));
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text: userText });
    if (mapped.command === "new" && !mapped.message) {
      const ack = "已创建新会话。";
      if (streaming) {
        writeChatCompletionStream(res, this.modelName, ack);
      } else {
        sendJson(res, 200, buildChatCompletion(this.modelName, ack));
      }
      return;
    }
    if (!mapped.message) {
      sendJson(res, 400, createApiServerErrorBody({
        event: "api_empty_message",
        message: "Empty message",
        code: "empty_message",
        status: 400,
        userHint: "Send a non-empty user message.",
      }));
      return;
    }

    this.activeChats.add(chatId);
    try {
      if (streaming) {
        await this.streamTurn(res, chatId, mapped.sessionKey, mapped.message);
      } else {
        await this.bufferedTurn(res, chatId, mapped.sessionKey, mapped.message);
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async streamTurn(res: ServerResponse, chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) {
      sendJson(res, 503, createApiServerErrorBody({
        event: "gateway_unavailable",
        message: "Gateway not ready",
        code: "gateway_unavailable",
        status: 503,
        type: "server_error",
        scope: "preflight",
        userHint: "Start or reconnect the PilotDeck gateway, then retry.",
      }));
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Hermes-Session-Id", chatId);
    res.statusCode = 200;
    res.flushHeaders?.();

    const timeout = setTimeout(() => {
      this.logger?.warn?.(`api-server: stream timeout for ${chatId}`);
      try { res.end(); } catch { /* best effort */ }
    }, REQUEST_TIMEOUT_MS);

    try {
      let hasVisibleFailureStatus = false;
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "api_server",
        message,
      })) {
        if (isVisibleFailureGatewayEvent(event)) {
          hasVisibleFailureStatus = true;
        }
        if (event.type === "error" && hasVisibleFailureStatus) {
          continue;
        }
        const fragment = renderApiServerEvent(event);
        if (fragment != null && fragment.length > 0) {
          writeStreamChunk(res, this.modelName, fragment);
        }
      }
      writeStreamDone(res, this.modelName);
    } catch (e) {
      this.logger?.error?.(`api-server: stream submitTurn error: ${e}`);
      try {
        res.write(`data: ${JSON.stringify(createApiServerErrorBody({
          event: "channel_submit_failed",
          message: String(e),
          code: "channel_submit_failed",
          status: 500,
          type: "server_error",
          scope: "channel",
          userHint: "PilotDeck failed before this API request could finish. Retry the request; if it repeats, check the API server and gateway logs.",
        }))}\n\n`);
      } catch { /* best effort */ }
    } finally {
      clearTimeout(timeout);
      try { res.end(); } catch { /* best effort */ }
    }
  }

  private async bufferedTurn(res: ServerResponse, chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) {
      sendJson(res, 503, createApiServerErrorBody({
        event: "gateway_unavailable",
        message: "Gateway not ready",
        code: "gateway_unavailable",
        status: 503,
        type: "server_error",
        scope: "preflight",
        userHint: "Start or reconnect the PilotDeck gateway, then retry.",
      }));
      return;
    }

    let replyText = "";
    const timeout = setTimeout(() => {
      this.logger?.warn?.(`api-server: buffered turn timeout for ${chatId}`);
    }, REQUEST_TIMEOUT_MS);

    try {
      let hasVisibleFailureStatus = false;
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "api_server",
        message,
      })) {
        if (isVisibleFailureGatewayEvent(event)) {
          hasVisibleFailureStatus = true;
        }
        if (event.type === "error" && hasVisibleFailureStatus) {
          continue;
        }
        const fragment = renderApiServerEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      clearTimeout(timeout);
      this.logger?.error?.(`api-server: submitTurn error: ${e}`);
      sendJson(res, 500, createApiServerErrorBody({
        event: "channel_submit_failed",
        message: String(e),
        code: "channel_submit_failed",
        status: 500,
        type: "server_error",
        scope: "channel",
        userHint: "PilotDeck failed before this API request could finish. Retry the request; if it repeats, check the API server and gateway logs.",
      }));
      return;
    }
    clearTimeout(timeout);

    res.setHeader("X-Hermes-Session-Id", chatId);
    sendJson(res, 200, buildChatCompletion(this.modelName, replyText.trim()));
  }
}

function parseWorkspaceMappings(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, mappedPath]) =>
      typeof mappedPath === "string" && key.trim() && mappedPath.trim()
        ? [[key.trim(), resolve(mappedPath)]]
        : []));
  } catch {
    return {};
  }
}

function safeStableId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[a-zA-Z0-9._-]{1,200}$/u.test(normalized) ? normalized : "";
}

function groupTurnCachePath(idempotencyKey: string): string {
  const pilotHome = process.env.PILOT_HOME || join(homedir(), ".pilotdeck");
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return join(pilotHome, "group-turn-idempotency", `${digest}.json`);
}

async function readGroupTurnCache(idempotencyKey: string): Promise<GatewayEvent[] | null> {
  try {
    const parsed = JSON.parse(await readFile(groupTurnCachePath(idempotencyKey), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as GatewayEvent[] : null;
  } catch {
    return null;
  }
}

async function writeGroupTurnCache(idempotencyKey: string, events: GatewayEvent[]): Promise<void> {
  const target = groupTurnCachePath(idempotencyKey);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(events), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function writeNdjsonEvents(res: ServerResponse, events: GatewayEvent[], cached: boolean): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  for (const event of events) res.write(`${JSON.stringify(event)}\n`);
  res.end(`${JSON.stringify({ type: "group_turn_stream_end", cached })}\n`);
}

function readRequestBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function createApiServerErrorBody(input: {
  event: string;
  message: string;
  code?: string;
  status?: number;
  type?: string;
  userHint?: string;
  scope?: "http" | "session" | "preflight" | "channel";
  detail?: Record<string, unknown>;
}) {
  return createAgentStatusHttpErrorBody({
    ...input,
    scope: input.scope ?? "http",
    source: "api_server",
  });
}

function isVisibleFailureGatewayEvent(event: GatewayEvent): boolean {
  return event.type === "agent_status" && isVisibleFailureStatusDetail(event.detail);
}

function parseCorsOrigins(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [];
}

function normalizeContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" || item?.type === "input_text") return item.text ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function buildChatCompletion(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function writeStreamChunk(res: ServerResponse, model: string, content: string): void {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeStreamDone(res: ServerResponse, model: string): void {
  const doneChunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`);
}

function writeChatCompletionStream(res: ServerResponse, model: string, content: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.statusCode = 200;
  writeStreamChunk(res, model, content);
  writeStreamDone(res, model);
  res.end();
}
