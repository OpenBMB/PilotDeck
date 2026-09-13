import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PilotDeckError } from "./types.js";
import type {
  PilotDeckMcpServer,
  PilotDeckMcpServerOptions,
  PilotDeckMcpServerStartOptions,
  PilotDeckToolDefinition,
  PilotDeckToolResult,
} from "./types.js";

type StreamableConfig = Extract<import("./types.js").PilotDeckMcpTransportConfig, { type: "streamable_http" }>;

/**
 * Hosts SDK-defined tools as a standards-compliant, stateless Streamable HTTP
 * MCP server. The handler remains in the caller process; PilotDeck discovers
 * and invokes it through its pre-existing MCP runtime, never via WebSocket
 * function serialization.
 */
export class PilotDeckMcpServerImpl implements PilotDeckMcpServer {
  readonly name: string;
  readonly version?: string;
  readonly instructions?: string;
  readonly alwaysLoad?: boolean;
  readonly deferredTools: Array<{ name: string; searchHint?: string }>;
  readonly tools: PilotDeckToolDefinition[];

  private httpServer?: HttpServer;
  private startPromise?: Promise<StreamableConfig>;
  private endpoint?: StreamableConfig;
  private readonly activeCalls = new Set<AbortController>();
  private readonly timeoutMs?: number;

  constructor(options: PilotDeckMcpServerOptions) {
    if (!options.name.trim()) {
      throw new PilotDeckError({ code: "validation_error", message: "MCP server name is required." });
    }
    this.name = options.name;
    this.version = options.version;
    this.instructions = options.instructions;
    this.alwaysLoad = options.alwaysLoad;
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
      throw new PilotDeckError({ code: "validation_error", message: "MCP server timeout must be a positive finite number." });
    }
    this.timeoutMs = options.timeout;
    this.tools = (options.tools ?? []).map((tool) => {
      if (options.alwaysLoad === true && tool.extras?.alwaysLoad !== true) {
        return { ...tool, extras: { ...tool.extras, alwaysLoad: true } };
      }
      return tool.extras?.alwaysLoad === true
        ? { ...tool, extras: { ...tool.extras } }
        : tool;
    });
    this.deferredTools = this.tools
      .filter((tool) => tool.extras?.alwaysLoad === false || (this.alwaysLoad === false && tool.extras?.alwaysLoad !== true))
      .map((tool) => ({ name: tool.name, ...(tool.extras?.searchHint ? { searchHint: tool.extras.searchHint } : {}) }));
    const duplicate = this.tools.find((tool, index) => this.tools.findIndex((candidate) => candidate.name === tool.name) !== index);
    if (duplicate) {
      throw new PilotDeckError({ code: "validation_error", message: `MCP server ${this.name} has duplicate tool name: ${duplicate.name}` });
    }
  }

  get config(): StreamableConfig | undefined {
    return this.endpoint ? { ...this.endpoint, ...(this.endpoint.headers ? { headers: { ...this.endpoint.headers } } : {}) } : undefined;
  }

  async start(options: PilotDeckMcpServerStartOptions = {}): Promise<StreamableConfig> {
    if (!this.startPromise) this.startPromise = this.startInternal(options);
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this.endpoint = undefined;
    this.startPromise = undefined;
    for (const controller of this.activeCalls) controller.abort();
    this.activeCalls.clear();
    await closeHttpServer(server);
  }

  private async startInternal(options: PilotDeckMcpServerStartOptions): Promise<StreamableConfig> {
    const path = normalizePath(options.path);
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    const httpServer = createServer((request, response) => {
      if (!request.url || new URL(request.url, "http://localhost").pathname !== path) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "PilotDeck SDK MCP endpoint not found." }));
        return;
      }
      // Stateless Streamable HTTP makes each HTTP request its own MCP
      // transport/session. This is required for the client's initialized
      // notification and later tools/list/tools/call requests to work.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const protocol = this.createProtocol();
      response.once("close", () => {
        void Promise.allSettled([protocol.close(), transport.close()]);
      });
      void protocol.connect(transport)
        .then(() => transport.handleRequest(request, response))
        .catch((cause: unknown) => {
          if (response.headersSent) return;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: cause instanceof Error ? cause.message : "MCP endpoint failed." }, id: null }));
        });
    });

    try {
      await listen(httpServer, port, host);
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new PilotDeckError({ code: "server_error", message: "SDK MCP server did not expose a TCP address." });
      }
      const localUrl = `http://${formatHost(address.address)}:${address.port}${path}`;
      const url = options.publicUrl ? normalizePublicEndpoint(options.publicUrl) : localUrl;
      this.httpServer = httpServer;
      this.endpoint = { type: "streamable_http", url, ...(this.timeoutMs !== undefined ? { timeout: this.timeoutMs } : {}) };
      return this.config!;
    } catch (cause) {
      await closeHttpServer(httpServer);
      throw cause instanceof PilotDeckError
        ? cause
        : new PilotDeckError({ code: "server_error", message: `Unable to start SDK MCP server ${this.name}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
  }

  private createProtocol(): Server {
    const protocol = new Server(
      { name: this.name, version: this.version ?? "0.1.0" },
      { capabilities: { tools: { listChanged: false } }, ...(this.instructions !== undefined ? { instructions: this.instructions } : {}) },
    );

    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: asMcpInputSchema(tool),
        ...(tool.extras?.annotations ? {
          annotations: {
            ...(tool.extras.annotations.readOnly !== undefined ? { readOnlyHint: tool.extras.annotations.readOnly } : {}),
            ...(tool.extras.annotations.destructive !== undefined ? { destructiveHint: tool.extras.annotations.destructive } : {}),
          },
        } : {}),
      })),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = this.tools.find((candidate) => candidate.name === request.params.name);
      if (!tool) {
        return errorResult(`Unknown SDK MCP tool: ${request.params.name}`);
      }
      const controller = new AbortController();
      this.activeCalls.add(controller);
      const onAbort = () => controller.abort();
      extra.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const invoke = tool.handler((request.params.arguments ?? {}) as never, {
          signal: controller.signal,
          toolUseId: String(extra.requestId),
        });
        const result = this.timeoutMs === undefined
          ? await invoke
          : await withTimeout(invoke, this.timeoutMs, () => {
              controller.abort(new Error(`MCP tool call timed out after ${this.timeoutMs}ms.`));
              return new PilotDeckError({ code: "timeout", message: `MCP tool call timed out after ${this.timeoutMs}ms.` });
            });
        return toMcpResult(result);
      } catch (cause) {
        return errorResult(cause instanceof Error ? cause.message : String(cause));
      } finally {
        extra.signal.removeEventListener("abort", onAbort);
        this.activeCalls.delete(controller);
      }
    });
    return protocol;
  }
}

function asMcpInputSchema(tool: PilotDeckToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new PilotDeckError({ code: "validation_error", message: `SDK MCP tool ${tool.name} requires an object JSON schema.` });
  }
  const candidate = schema as Record<string, unknown>;
  if (candidate.type !== "object") {
    throw new PilotDeckError({ code: "validation_error", message: `SDK MCP tool ${tool.name} input schema must have type: \"object\".` });
  }
  return structuredClone(candidate);
}

function toMcpResult(result: PilotDeckToolResult): PilotDeckToolResult {
  return {
    content: result.content.map((item) => ({ ...item })),
    ...(result.isError ? { isError: true } : {}),
  };
}

function errorResult(message: string): PilotDeckToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorFactory: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function normalizePath(value: string | undefined): string {
  const path = value ?? "/mcp";
  if (!path.startsWith("/")) throw new PilotDeckError({ code: "validation_error", message: "MCP endpoint path must begin with '/'." });
  return path;
}

function normalizePublicEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new PilotDeckError({ code: "validation_error", message: "MCP publicUrl must be an absolute HTTP(S) endpoint URL." }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PilotDeckError({ code: "validation_error", message: "MCP publicUrl must use http: or https:." });
  }
  return url.toString();
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  // A Gateway-side Streamable HTTP client can retain an idle keep-alive
  // socket after a turn. Closing an SDK server must not make the caller wait
  // for that remote client to voluntarily disconnect.
  const closeIdleConnections = (server as HttpServer & { closeIdleConnections?: () => void }).closeIdleConnections;
  const closeAllConnections = (server as HttpServer & { closeAllConnections?: () => void }).closeAllConnections;
  closeIdleConnections?.call(server);
  closeAllConnections?.call(server);
  return new Promise((resolve) => server.close(() => resolve()));
}
