import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpClient } from "../../../src/mcp/client/McpClient.js";

test("McpClient keeps stdio clients idle before connection", () => {
  const client = new McpClient({ id: "stdio-test", transport: "stdio", command: "node" });
  assert.equal(client.getStatus(), "idle");
});

test("McpClient constructs streamable_http transport without requiring stdio fields", () => {
  const client = new McpClient({ id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" });
  assert.equal(client.getStatus(), "idle");
});

test("McpClient constructs a legacy SSE transport with the configured headers", () => {
  const client = new McpClient({
    id: "sse-test",
    transport: "sse",
    url: "https://mcp.example.test/events",
    headers: { authorization: "Bearer test-token" },
  });
  const transport = (client as unknown as { buildTransport(): unknown }).buildTransport();
  assert.ok(transport instanceof SSEClientTransport);
  assert.deepEqual((transport as unknown as { _requestInit?: RequestInit })._requestInit, {
    headers: { authorization: "Bearer test-token" },
  });
});

test("McpClient completes an MCP handshake and tool discovery through legacy SSE", async () => {
  const requests: Array<{ method?: string; authorization?: string }> = [];
  let eventStream: import("node:http").ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/events") {
      requests.push({ authorization: request.headers.authorization });
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      eventStream = response;
      response.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/messages") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: string | number; method?: string };
      requests.push({ method: message.method, authorization: request.headers.authorization });
      response.writeHead(202).end();
      if (!eventStream || message.id === undefined) return;
      if (message.method === "initialize") {
        sendSse(eventStream, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-sse", version: "1.0.0" },
          },
        });
      }
      if (message.method === "tools/list") {
        sendSse(eventStream, { jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      }
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new McpClient({
    id: "legacy-sse",
    transport: "sse",
    url: `http://127.0.0.1:${address.port}/events`,
    headers: { authorization: "Bearer test-token" },
  });
  try {
    await client.start();
    assert.equal(client.getStatus(), "ready");
    assert.deepEqual(await client.listTools(), []);
    assert.deepEqual(requests, [
      { authorization: "Bearer test-token" },
      { method: "initialize", authorization: "Bearer test-token" },
      { method: "notifications/initialized", authorization: "Bearer test-token" },
      { method: "tools/list", authorization: "Bearer test-token" },
    ]);
  } finally {
    await client.close();
    await close(server);
  }
});

test("McpClient routes streamable_http fetches with bounded timeouts", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit; timeoutMs?: number }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit, options?: { timeoutMs?: number }): Promise<Response> => {
    calls.push({ input, init, timeoutMs: options?.timeoutMs });
    return new Response("{}");
  };
  const client = new McpClient(
    { id: "http-test", transport: "streamable_http", url: "https://mcp.example.test/mcp" },
    { callTimeoutMs: 12_345, handshakeTimeoutMs: 2_345, fetch: fetchImpl as typeof fetch },
  );

  const transport = (client as unknown as { buildTransport(): unknown }).buildTransport();
  assert.ok(transport instanceof StreamableHTTPClientTransport);
  const transportFetch = (transport as unknown as { _fetch?: typeof fetch })._fetch;
  assert.equal(typeof transportFetch, "function");

  await transportFetch?.("https://mcp.example.test/mcp", { method: "GET" });
  assert.equal(calls.at(-1)?.timeoutMs, 2_345);

  await transportFetch?.("https://mcp.example.test/mcp", { method: "POST" });
  assert.equal(calls.at(-1)?.timeoutMs, 12_345);
});

function sendSse(response: import("node:http").ServerResponse, message: unknown): void {
  response.write(`data: ${JSON.stringify(message)}\n\n`);
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}
