import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { createWebSearchTool } from "../../../src/tool/builtin/webSearch.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const context = { env: {}, cwd: process.cwd() } as PilotDeckToolRuntimeContext;

function mockParallel(onSearch?: (signal: AbortSignal | null | undefined) => Promise<unknown>) {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://mcp.parallel.ai/mcp");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("User-Agent") ?? "", /^PilotDeck\/\S+$/);
    assert.equal(headers.has("Authorization"), false);
    const method = init?.method;
    if (method === "GET" || method === "DELETE") {
      requests.push(method);
      assert.equal(headers.get("Mcp-Session-Id"), "test-session");
      return new Response(null, { status: method === "GET" ? 405 : 204 });
    }
    const request = JSON.parse(String(init?.body));
    requests.push(request.method);
    const reply = (result: unknown, headers?: HeadersInit) =>
      Response.json({ jsonrpc: "2.0", id: request.id, result }, { headers });
    switch (request.method) {
      case "initialize":
        return reply({
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test-server", version: "1" },
        }, { "Mcp-Session-Id": "test-session" });
      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({ tools: [{ name: "web_search", inputSchema: { type: "object" } }] });
      case "tools/call":
        assert.equal(headers.get("Mcp-Session-Id"), "test-session");
        assert.deepEqual(request.params, {
          name: "web_search",
          arguments: { objective: "public docs", search_queries: ["public docs"] },
        });
        return reply(onSearch ? await onSearch(init?.signal) : {
          content: [{ type: "text", text: JSON.stringify({
            results: [{
              url: "https://example.com/docs",
              title: "Docs",
              excerpts: ["First passage", "Second passage"],
              publish_date: "2026-01-01",
            }, { url: "https://example.com/second" }],
          }) }],
        });
      default:
        assert.fail(`Unexpected MCP request ${request.method}`);
    }
  };
  return { requests, fetchImpl };
}

test("Parallel is keyless and maps MCP results to the usual capped citations", async () => {
  const { requests, fetchImpl } = mockParallel();
  const tool = createWebSearchTool({
    provider: "parallel",
    apiKey: "ignored-test-key",
    endpoint: "https://example.com/ignored",
    organicLimit: 1,
    fetchImpl,
  });
  assert.deepEqual(await tool.checkAvailability?.(context), { ok: true });
  const result = await tool.execute({ query: " public docs ", gl: "cn" }, context);
  assert.equal(result.data?.query, "public docs");
  assert.deepEqual(result.data?.organic, [{
    title: "Docs",
    link: "https://example.com/docs",
    snippet: "First passage\nSecond passage",
    publishedAt: "2026-01-01",
    source: undefined,
  }]);
  assert.match((result.content[0] as { text: string }).text, /https:\/\/example.com\/docs/);
  assert.deepEqual(requests.sort(), ["DELETE", "GET", "initialize", "notifications/initialized", "tools/call", "tools/list"].sort());
});

test("Parallel cancellation aborts an in-flight search and closes its MCP session", async () => {
  const controller = new AbortController();
  const { requests, fetchImpl } = mockParallel(async (signal) => {
    assert.ok(signal);
    const cancelled = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    controller.abort();
    return cancelled;
  });
  const tool = createWebSearchTool({ provider: "parallel", fetchImpl });
  await assert.rejects(
    tool.execute({ query: "public docs" }, { ...context, abortSignal: controller.signal }),
    { code: "tool_aborted" },
  );
  assert.ok(requests.includes("tools/call"));
  assert.ok(requests.includes("DELETE"));
});

test("an unconfigured default provider and an explicit other provider stay off Parallel", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.search.brave.com/res/v1/web/search?q=public+docs&count=8");
    assert.equal(new Headers(init?.headers).get("X-Subscription-Token"), "brave-test");
    return Response.json({ web: { results: [] } });
  };
  const defaultTool = createWebSearchTool({ fetchImpl });
  await assert.rejects(defaultTool.execute({ query: "public docs" }, context), { code: "setup_required" });
  assert.equal(calls, 0);
  const braveTool = createWebSearchTool({ provider: "brave", fetchImpl });
  const result = await braveTool.execute({ query: "public docs" }, { ...context, env: { BRAVE_API_KEY: "brave-test" } });
  assert.equal(result.metadata?.provider, "brave");
  assert.equal(calls, 1);
});

test("Parallel does not follow redirects carrying search data or a session ID", async () => {
  const { createServer } = await import("node:http");
  const sockets = new Set<import("node:net").Socket>();
  let redirected = 0;
  const destination = createServer((_request, response) => {
    redirected++;
    response.writeHead(200).end();
  });
  const close = async (server: import("node:http").Server) => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  };
  await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve));
  const destinationPort = (destination.address() as import("node:net").AddressInfo).port;

  try {
    for (const target of ["tools/call", "DELETE"]) {
      const { fetchImpl: mockFetch } = mockParallel();
      const origin = createServer((request, response) => {
        response.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}` }).end();
        request.resume();
      });
      origin.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
      const originPort = (origin.address() as import("node:net").AddressInfo).port;
      let attempts = 0;
      try {
        const fetchImpl: typeof fetch = (input, init) => {
          const method = init?.method === "POST" ? JSON.parse(String(init.body)).method : init?.method;
          if (method !== target) return mockFetch(input, init);
          attempts++;
          return fetch(`http://127.0.0.1:${originPort}`, init);
        };
        const pending = createWebSearchTool({ provider: "parallel", fetchImpl }).execute({ query: "public docs" }, context);
        if (target === "tools/call") {
          await assert.rejects(pending, { code: "tool_execution_failed" });
        } else {
          assert.equal((await pending).data?.organic[0]?.link, "https://example.com/docs");
        }
        assert.equal(attempts, 1);
        assert.equal(redirected, 0);
      } finally {
        await close(origin);
      }
    }
  } finally {
    await close(destination);
  }
});

test("disabled or denied web search sends no Parallel requests", async () => {
  const fetchImpl: typeof fetch = async () => assert.fail("Web search must remain offline");
  const permissionMode = "default";
  const permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: permissionMode,
    rules: { deny: [{ toolName: "web_search", behavior: "deny", source: "user" }] },
  });
  const call = { id: "search-test", name: "web_search", input: { query: "public docs" } };
  for (const [webSearch, errorCode] of [
    [false, "tool_unavailable"],
    [{ provider: "parallel", fetchImpl }, "permission_denied"],
  ] as const) {
    const runtime = new ToolRuntime(createBuiltinRegistry({ webSearch }), new PermissionRuntime());
    const result = await runtime.execute(call, {
      ...context,
      sessionId: "search-test",
      turnId: "search-test",
      permissionMode,
      permissionContext,
    });
    assert.equal(result.type === "error" && result.error.code, errorCode);
  }
});
