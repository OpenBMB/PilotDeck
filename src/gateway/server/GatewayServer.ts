import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import type { Gateway } from "../protocol/types.js";
import { createWebSocketAcceptValue, TextWebSocketConnection } from "./websocket.js";
import { GatewayWsConnection } from "./GatewayWsConnection.js";
import { ensureGatewayAuthToken } from "./authToken.js";
import { serveStaticAsset } from "./staticAssets.js";
import { handleWebApiRequest } from "../../adapters/web/httpRouter.js";

export type GatewayServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  token?: string;
  staticAssetsPath?: string;
  serverVersion?: string;
  feishuWebhook?: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<boolean> | boolean;
  /**
   * Resolves a `projectKey` (as supplied by the Web UI) to an absolute
   * project root. If unset, the projectKey is used verbatim as the root.
   */
  resolveProject?: (projectKey: string) => string;
};

export type GatewayServer = {
  url: string;
  wsUrl: string;
  token: string;
  tokenPath?: string;
  close(): Promise<void>;
  broadcastNotification(name: string, payload?: unknown): void;
};

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("GatewayServer only supports localhost binding in the first phase.");
  }
  const auth = options.token
    ? { token: options.token, tokenPath: undefined }
    : await ensureGatewayAuthToken();

  const connections = new Set<GatewayWsConnection>();

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, auth.token);
  });
  server.on("upgrade", (request, socket) =>
    handleUpgrade(request, socket, options, auth.token, connections),
  );

  await listen(server, options.port ?? 18789, host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 18789;
  return {
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    token: auth.token,
    tokenPath: auth.tokenPath,
    close: () => close(server),
    broadcastNotification(name: string, payload?: unknown) {
      for (const conn of connections) {
        conn.sendNotification(name, payload);
      }
    },
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
  token: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/auth/local-token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token }));
    return;
  }
  if (url.pathname === "/feishu/webhook" && options.feishuWebhook) {
    const body = await readBody(request);
    const handled = await options.feishuWebhook(request, response, body);
    if (handled) {
      return;
    }
  }
  if (url.pathname.startsWith("/api/web/")) {
    const handled = await handleWebApiRequest(request, response, {
      gateway: options.gateway,
      token,
      resolveProject: options.resolveProject,
    });
    if (handled) {
      return;
    }
  }
  if (options.staticAssetsPath && serveStaticAsset(resolve(options.staticAssetsPath), url.pathname, response)) {
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  options: GatewayServerOptions,
  token: string,
  connections: Set<GatewayWsConnection>,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${createWebSocketAcceptValue(key)}`,
      "",
      "",
    ].join("\r\n"),
  );
  const ws = new TextWebSocketConnection(socket as Socket);
  const conn = new GatewayWsConnection(ws, {
    gateway: options.gateway,
    token,
    serverVersion: options.serverVersion ?? "0.1.0",
  });
  connections.add(conn);
  conn.onClose(() => connections.delete(conn));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
