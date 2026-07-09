import assert from "node:assert/strict";
import test from "node:test";
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
