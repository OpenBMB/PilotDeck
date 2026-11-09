import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpRuntime } from "../../src/mcp/runtime/McpRuntime.js";
import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";
import { createMcpToolCatalogRefresher } from "../../src/mcp/runtime/McpToolRegistryBinding.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

const readTool = (name: string): Tool => ({ name, description: `Synthetic ${name}`, inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true } });

async function fixture(t: TestContext) {
  let catalog = [readTool("read")];
  let lists = 0;
  let calls = 0;
  let pageSize = Infinity;
  let listGate: (() => Promise<void>) | undefined;
  let callGate: (() => Promise<void>) | undefined;
  const servers: Server[] = [];
  const runtime = new McpRuntime([{ id: "synthetic", transport: "stdio", command: "unused" }], { clientOptions: {
    transportFactory: () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "synthetic", version: "1" }, { capabilities: { tools: { listChanged: true } } });
      servers.push(server);
      server.setRequestHandler(ListToolsRequestSchema, async request => {
        lists++;
        const start = Number(request.params?.cursor ?? "0");
        const end = Math.min(catalog.length, start + pageSize);
        const result = { tools: structuredClone(catalog.slice(start, end)), ...(end < catalog.length ? { nextCursor: String(end) } : {}) };
        await listGate?.();
        return result;
      });
      server.setRequestHandler(CallToolRequestSchema, async () => { calls++; await callGate?.(); return { content: [{ type: "text", text: "synthetic result" }] }; });
      void server.connect(serverTransport);
      return clientTransport;
    },
  } });
  t.after(async () => { await runtime.stop(); await Promise.all(servers.map(server => server.close())); });
  await runtime.start();
  return { runtime, client: runtime.getClient("synthetic")!, get lists() { return lists; }, get calls() { return calls; },
    setCatalog(next: Tool[]) { catalog = next; }, setPageSize(size: number) { pageSize = size; },
    setListGate(gate?: () => Promise<void>) { listGate = gate; },
    setCallGate(gate?: () => Promise<void>) { callGate = gate; },
    get connections() { return servers.length; },
    async changed() { await servers.at(-1)!.sendToolListChanged(); await tick(); },
    async disconnect() { await servers.at(-1)!.close(); await tick(); },
  };
}

test("tool-list notifications invalidate cached schemas and removed tools", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).map(tool => tool.toolName), ["read"]);
  f.setCatalog([readTool("replacement")]);
  await f.changed();
  assert.deepEqual((await f.client.listTools()).map(tool => tool.toolName), ["replacement"]);
});

test("notification during listing discards the obsolete response", async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setListGate(() => gate);
  const pending = f.client.listTools();
  await tick();
  assert.equal(f.lists, 1);
  f.setCatalog([readTool("new")]);
  await f.changed();
  release();
  assert.deepEqual((await pending).map(tool => tool.toolName), ["new"]);
  assert.equal(f.lists, 2);
});

test("one canceled catalog reader does not cancel another session's refresh", async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.setListGate(() => new Promise<void>(resolve => { release = resolve; }));
  const abort = new AbortController();
  const canceled = f.runtime.refreshToolCatalog(abort.signal);
  const surviving = f.runtime.refreshToolCatalog();
  await tick();
  abort.abort(new Error("synthetic cancellation"));
  await assert.rejects(canceled, /synthetic cancellation/);
  release();
  assert.equal((await surviving).length, 1);
  assert.equal(f.lists, 1);
});

test("refresh updates only the supplied registry and preserves child exclusions", async t => {
  const f = await fixture(t);
  const parent = new ToolRegistry();
  for (const tool of await createMcpToolDefinitionsFromRuntime(f.runtime)) parent.register(tool);
  const child = parent.clone();
  const refresh = createMcpToolCatalogRefresher([f.runtime]);
  await refresh.refresh(parent);
  await refresh.refresh(child, undefined, tool => tool.name.endsWith("__read"));
  const before = parent.get("mcp__synthetic__read");
  f.setCatalog([readTool("read"), readTool("new")]);
  await f.changed();
  await refresh.refresh(child);
  assert.deepEqual(child.list().map(tool => tool.name), ["mcp__synthetic__read"]);
  assert.equal(parent.get("mcp__synthetic__read"), before);
  assert.equal(parent.has("mcp__synthetic__new"), false);
  await refresh.refresh(parent);
  assert.equal(parent.has("mcp__synthetic__new"), true);
  f.setCatalog([readTool("new")]);
  await f.changed();
  await refresh.refresh(child);
  assert.equal(child.list().length, 0);
});

test("catalog refresh keeps already dispatched calls alive and fences queued removed calls", async t => {
  const f = await fixture(t);
  const [old] = await createMcpToolDefinitionsFromRuntime(f.runtime);
  let release!: () => void;
  f.setCallGate(() => new Promise<void>(resolve => { release = resolve; }));
  const running = old.execute({}, {} as never);
  await tick();
  assert.equal(f.calls, 1);
  f.setCatalog([]);
  await f.changed();
  assert.deepEqual(await f.runtime.refreshToolCatalog(), []);
  await assert.rejects(old.execute({}, {} as never), /catalog.*changed/i);
  release();
  assert.deepEqual((await running).content, [{ type: "text", text: "synthetic result" }]);
  assert.equal(f.calls, 1);
  assert.equal(f.connections, 1);
});

test("failed refresh preserves the last complete registry; disposal prevents late publication", async t => {
  const f = await fixture(t);
  const registry = new ToolRegistry();
  for (const tool of await createMcpToolDefinitionsFromRuntime(f.runtime)) registry.register(tool);
  const refresh = createMcpToolCatalogRefresher([f.runtime]);
  const before = registry.toCanonicalSchemas();
  f.setCatalog([readTool("new")]);
  await f.changed();
  f.setListGate(async () => { throw new Error("synthetic discovery failure"); });
  await refresh.refresh(registry);
  assert.deepEqual(registry.toCanonicalSchemas(), before);
  let release!: () => void;
  f.setListGate(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = refresh.refresh(registry);
  await tick();
  refresh.dispose();
  release();
  await pending;
  assert.deepEqual(registry.toCanonicalSchemas(), before);
});

test("reconnecting publishes the new catalog and stopping discovery never restarts a client", async t => {
  const f = await fixture(t);
  await f.runtime.listAllTools();
  f.setCatalog([readTool("reconnected")]);
  await f.disconnect();
  assert.deepEqual((await f.runtime.refreshToolCatalog()).map(tool => tool.toolName), ["reconnected"]);
  assert.equal(f.connections, 2);
  let release!: () => void;
  f.setListGate(() => new Promise<void>(resolve => { release = resolve; }));
  await f.changed();
  const pending = f.client.listTools();
  const stopped = assert.rejects(pending, /closed/);
  await tick();
  await f.runtime.stop();
  release();
  await stopped;
  await tick();
  assert.equal(f.connections, 2);
  assert.equal(f.client.getStatus(), "idle");
});

test("concurrent catalog readers share one list request", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.client.listTools(), f.client.listTools(), f.client.listTools()]);
  assert.equal(f.lists, 1);
  assert.deepEqual(results[0], results[1]);
});

test("an old tool definition cannot dispatch after schema or safety annotations change", async t => {
  const f = await fixture(t);
  const [old] = await createMcpToolDefinitionsFromRuntime(f.runtime);
  f.setCatalog([{ ...readTool("read"), inputSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: true } }]);
  await f.changed();
  await assert.rejects(old.execute({}, {} as never), /catalog.*changed/i);
  assert.equal(f.calls, 0);
  const [updated] = await createMcpToolDefinitionsFromRuntime(f.runtime);
  assert.equal(updated.isReadOnly({}), false);
  assert.equal(updated.isConcurrencySafe({}), false);
  await updated.execute({ target: "synthetic" }, {} as never);
  assert.equal(f.calls, 1);
});

test("paginated tool catalogs retain every page", async t => {
  const f = await fixture(t);
  f.setCatalog([readTool("first"), readTool("second")]);
  f.setPageSize(1);
  assert.deepEqual((await f.client.listTools()).map(tool => tool.toolName), ["first", "second"]);
});
