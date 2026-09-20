import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
  createKnowledgeModulePort,
  createKnowledgeQueryTool,
  createSkillManagementPort,
  createSkillModulePort,
} from "../../src/composition/domainPorts.js";
import { createRuntimeModulePorts } from "../../src/composition/runtimePorts.js";
import type { ExternalModuleBinding } from "../../src/composition/types.js";

test("unknown model, tool, and context implementations execute through module-http-v2", async (t) => {
  const calls: Array<{ implementationId: string; operation: string }> = [];
  const server = createServer(async (request, response) => route(request, response, calls));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const bindings = {
    modelProvider: binding("unknown.model", "pilotdeck.model/v1", endpoint, ["prepare", "stream"]),
    tools: {
      ...binding("unknown.tools", "pilotdeck.tools/v1", endpoint, ["execute"]),
      tools: [{
        name: "remote_lookup",
        description: "Remote lookup",
        kind: "custom" as const,
        inputSchema: { type: "object" as const },
        readOnly: true,
        concurrencySafe: true,
      }],
    },
    context: binding("unknown.context", "pilotdeck.context/v1", endpoint, ["prepare_for_model"]),
  };
  const ports = createRuntimeModulePorts(bindings, "session-1");
  const execution = { sessionId: "session-1", turnId: "turn-1", runId: "run-1" };

  const prepared = await ports.model!.prepare({
    request: { provider: "remote", model: "m", messages: [] },
    context: execution,
  });
  const events = [];
  for await (const event of ports.model!.stream({ prepared, context: execution })) events.push(event);
  assert.equal(events.at(-1)?.type, "message_end");

  const toolContext = {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/tmp",
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
  };
  const [toolResult] = await ports.tools!.executeAll(
    [{ id: "tool-1", name: "remote_lookup", input: { key: "v" } }],
    toolContext,
    execution,
  );
  assert.equal(toolResult?.type, "success");

  const context = await ports.context!.prepareForModel({
    ...execution,
    cwd: "/tmp",
    provider: "remote",
    model: "m",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
  });
  assert.deepEqual(context.systemPromptParts, ["external context"]);
  assert.deepEqual(calls, [
    { implementationId: "unknown.model", operation: "prepare" },
    { implementationId: "unknown.model", operation: "stream" },
    { implementationId: "unknown.tools", operation: "execute" },
    { implementationId: "unknown.context", operation: "prepare_for_model" },
  ]);
});

test("manifest mismatch is rejected before the first module call and retried later", async (t) => {
  let manifestCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      manifestCalls += 1;
      return json(response, manifestCalls === 1
        ? manifest("wrong.model", "pilotdeck.model/v1", ["prepare", "stream"])
        : manifest("unknown.model", "pilotdeck.model/v1", ["prepare", "stream"]));
    }
    const body = await readJson(request) as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    json(response, {
      kind: "response",
      messageId: `response-${String(body.messageId)}`,
      inReplyTo: body.messageId,
      requestId: body.requestId,
      ok: true,
      payload: { prepared: { request: payload.request, provider: "remote", model: "m" } },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    modelProvider: binding("unknown.model", "pilotdeck.model/v1", `http://127.0.0.1:${address.port}`, ["prepare", "stream"]),
  }, "session-1");
  const input = {
    request: { provider: "remote", model: "m", messages: [] },
    context: { sessionId: "session-1", turnId: "turn-1", runId: "run-1" },
  };
  await assert.rejects(() => ports.model!.prepare(input), (error: unknown) => (error as { code?: string }).code === "MODULE_PROTOCOL_INCOMPATIBLE");
  await ports.model!.prepare(input);
  assert.equal(manifestCalls, 2, "a failed manifest must not be cached");
});

test("structured module failures survive non-success HTTP status codes", async (t) => {
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.knowledge", "staffdeck.knowledge/v1", ["query"]));
    const body = await readJson(request) as Record<string, unknown>;
    json(response, {
      kind: "response",
      messageId: `response-${String(body.messageId)}`,
      inReplyTo: body.messageId,
      requestId: body.requestId,
      ok: false,
      code: "KNOWLEDGE_BASE_NOT_FOUND",
      error: {
        code: "KNOWLEDGE_BASE_NOT_FOUND",
        message: "Knowledge base does not exist.",
        retryability: "unsafe",
        details: { knowledgeBaseId: "missing" },
      },
    }, 422);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const knowledge = createKnowledgeModulePort(binding(
    "unknown.knowledge",
    "staffdeck.knowledge/v1",
    `http://127.0.0.1:${address.port}`,
    ["query"],
  ));

  await assert.rejects(
    () => knowledge.call("query", { query: "missing" }),
    (error: unknown) => (error as { code?: string }).code === "KNOWLEDGE_BASE_NOT_FOUND"
      && (error as Error).message === "Knowledge base does not exist.",
  );
});

test("external Tool timeout is fail-closed and does not retry a potentially side-effecting call", async (t) => {
  let toolCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.tools", "pilotdeck.tools/v1", ["execute"]));
    toolCalls += 1;
    await delay(100);
    if (!response.destroyed) json(response, { ignored: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    tools: {
      ...binding("unknown.tools", "pilotdeck.tools/v1", `http://127.0.0.1:${address.port}`, ["execute"]),
      timeoutMs: 20,
      tools: [{
        name: "write_remote_record",
        description: "Potentially writes a remote record.",
        inputSchema: { type: "object" },
        readOnly: false,
        concurrencySafe: false,
      }],
    },
  }, "session-timeout");
  const [result] = await ports.tools!.executeAll(
    [{ id: "tool-timeout", name: "write_remote_record", input: { value: "one" } }],
    toolContext("session-timeout"),
    { sessionId: "session-timeout", turnId: "turn-timeout", runId: "run-timeout" },
  );
  assert.equal(toolCalls, 1, "transport uncertainty must not automatically replay a side effect");
  assert.equal(result?.type, "error");
  assert.equal(result?.type === "error" && result.error.code, "tool_timeout");
  assert.deepEqual(result?.type === "error" ? result.error.details : undefined, {
    moduleCode: "MODULE_TIMEOUT",
    outcome: "result_unknown",
    retryability: "unsafe",
  });
});

test("external Tool disconnect after dispatch is fail-closed and does not replay a side effect", async (t) => {
  let toolCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.tools", "pilotdeck.tools/v1", ["execute"]));
    toolCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    tools: {
      ...binding("unknown.tools", "pilotdeck.tools/v1", `http://127.0.0.1:${address.port}`, ["execute"]),
      timeoutMs: 2_000,
      tools: [{
        name: "write_remote_record",
        description: "Potentially writes a remote record.",
        inputSchema: { type: "object" },
        readOnly: false,
        concurrencySafe: false,
      }],
    },
  }, "session-disconnect");
  const [result] = await ports.tools!.executeAll(
    [{ id: "tool-disconnect", name: "write_remote_record", input: { value: "one" } }],
    toolContext("session-disconnect"),
    { sessionId: "session-disconnect", turnId: "turn-disconnect", runId: "run-disconnect" },
  );
  assert.equal(toolCalls, 1, "a disconnect after dispatch must not replay a side effect");
  assert.equal(result?.type, "error");
  assert.equal(result?.type === "error" && result.error.code, "tool_execution_failed");
  assert.deepEqual(result?.type === "error" ? result.error.details : undefined, {
    moduleCode: "MODULE_TRANSPORT_UNAVAILABLE",
    outcome: "result_unknown",
    retryability: "unsafe",
  });
});

test("external Tool request observes caller cancellation without projecting a completed result", async (t) => {
  let toolCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.tools", "pilotdeck.tools/v1", ["execute"]));
    toolCalls += 1;
    await delay(100);
    if (!response.destroyed) json(response, { ignored: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    tools: {
      ...binding("unknown.tools", "pilotdeck.tools/v1", `http://127.0.0.1:${address.port}`, ["execute"]),
      timeoutMs: 2_000,
      tools: [{
        name: "write_remote_record",
        description: "Potentially writes a remote record.",
        inputSchema: { type: "object" },
        readOnly: false,
        concurrencySafe: false,
      }],
    },
  }, "session-abort");
  const abort = new AbortController();
  const executing = ports.tools!.executeAll(
    [{ id: "tool-abort", name: "write_remote_record", input: { value: "one" } }],
    toolContext("session-abort"),
    { sessionId: "session-abort", turnId: "turn-abort", runId: "run-abort", abortSignal: abort.signal },
  );
  await waitFor(() => toolCalls === 1);
  abort.abort();
  await assert.rejects(executing, /Tool execution cancelled/);
  assert.equal(toolCalls, 1);
});

test("external Model prepare timeout remains an unknown transport outcome", async (t) => {
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.model", "pilotdeck.model/v1", ["prepare", "stream"]));
    modelCalls += 1;
    await delay(100);
    if (!response.destroyed) json(response, { ignored: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    modelProvider: {
      ...binding("unknown.model", "pilotdeck.model/v1", `http://127.0.0.1:${address.port}`, ["prepare", "stream"]),
      timeoutMs: 20,
    },
  }, "model-timeout-session");

  await assert.rejects(
    () => ports.model!.prepare({
      request: { provider: "remote", model: "m", messages: [] },
      context: { sessionId: "model-timeout-session", turnId: "model-timeout-turn", runId: "model-timeout-run" },
    }),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TIMEOUT"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(modelCalls, 1);
});

test("external Model prepare disconnect after dispatch remains an unknown transport outcome", async (t) => {
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.model", "pilotdeck.model/v1", ["prepare", "stream"]));
    modelCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    modelProvider: {
      ...binding("unknown.model", "pilotdeck.model/v1", `http://127.0.0.1:${address.port}`, ["prepare", "stream"]),
      timeoutMs: 2_000,
    },
  }, "model-disconnect-session");

  await assert.rejects(
    () => ports.model!.prepare({
      request: { provider: "remote", model: "m", messages: [] },
      context: { sessionId: "model-disconnect-session", turnId: "model-disconnect-turn", runId: "model-disconnect-run" },
    }),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TRANSPORT_UNAVAILABLE"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(modelCalls, 1, "a transport disconnect must not automatically replay the model request");
});

test("external Model stream disconnect before its first event remains an unknown transport outcome", async (t) => {
  let streamCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.model", "pilotdeck.model/v1", ["stream"]));
    streamCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    modelProvider: {
      ...binding("unknown.model", "pilotdeck.model/v1", `http://127.0.0.1:${address.port}`, ["stream"]),
      timeoutMs: 2_000,
    },
  }, "model-stream-disconnect-session");
  const context = {
    sessionId: "model-stream-disconnect-session",
    turnId: "model-stream-disconnect-turn",
    runId: "model-stream-disconnect-run",
  };
  const prepared = await ports.model!.prepare({
    request: { provider: "remote", model: "m", messages: [] },
    context,
  });

  await assert.rejects(
    () => ports.model!.stream({ prepared, context })[Symbol.asyncIterator]().next(),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TRANSPORT_UNAVAILABLE"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(streamCalls, 1, "a stream disconnect before an event must not automatically replay the model request");
});

test("external Model stream observes caller cancellation before yielding an event", async (t) => {
  let streamCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.model", "pilotdeck.model/v1", ["stream"]));
    streamCalls += 1;
    await delay(100);
    if (!response.destroyed) json(response, { ignored: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    modelProvider: {
      ...binding("unknown.model", "pilotdeck.model/v1", `http://127.0.0.1:${address.port}`, ["stream"]),
      timeoutMs: 2_000,
    },
  }, "model-abort-session");
  const abort = new AbortController();
  const context = {
    sessionId: "model-abort-session",
    turnId: "model-abort-turn",
    runId: "model-abort-run",
    abortSignal: abort.signal,
  };
  const prepared = await ports.model!.prepare({
    request: { provider: "remote", model: "m", messages: [] },
    context,
  });
  const next = ports.model!.stream({ prepared, context })[Symbol.asyncIterator]().next();
  await waitFor(() => streamCalls === 1);
  abort.abort();
  await assert.rejects(
    next,
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_ABORTED"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(streamCalls, 1);
});

test("external Context request observes caller cancellation as an aborted transport", async (t) => {
  let contextCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.context", "pilotdeck.context/v1", ["prepare_for_model"]));
    contextCalls += 1;
    await delay(100);
    if (!response.destroyed) json(response, { ignored: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    context: {
      ...binding("unknown.context", "pilotdeck.context/v1", `http://127.0.0.1:${address.port}`, ["prepare_for_model"]),
      timeoutMs: 2_000,
    },
  }, "context-abort-session");
  const abort = new AbortController();
  const preparing = ports.context!.prepareForModel({
    sessionId: "context-abort-session",
    turnId: "context-abort-turn",
    cwd: "/tmp",
    provider: "remote",
    model: "m",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [],
    tools: [],
    abortSignal: abort.signal,
  });
  await waitFor(() => contextCalls === 1);
  abort.abort();
  await assert.rejects(
    preparing,
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_ABORTED"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(contextCalls, 1);
});

test("external Context disconnect after dispatch remains an unknown transport outcome", async (t) => {
  let contextCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.context", "pilotdeck.context/v1", ["prepare_for_model"]));
    contextCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const ports = createRuntimeModulePorts({
    context: {
      ...binding("unknown.context", "pilotdeck.context/v1", `http://127.0.0.1:${address.port}`, ["prepare_for_model"]),
      timeoutMs: 2_000,
    },
  }, "context-disconnect-session");

  await assert.rejects(
    () => ports.context!.prepareForModel({
      sessionId: "context-disconnect-session",
      turnId: "context-disconnect-turn",
      cwd: "/tmp",
      provider: "remote",
      model: "m",
      permissionMode: "default",
      additionalWorkingDirectories: [],
      messages: [],
      tools: [],
    }),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TRANSPORT_UNAVAILABLE"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(contextCalls, 1, "a context request must not automatically replay after a disconnect");
});

test("contradictory success and failure envelopes are rejected as protocol errors", async (t) => {
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.knowledge", "staffdeck.knowledge/v1", ["query"]));
    const body = await readJson(request) as Record<string, unknown>;
    json(response, {
      kind: "response",
      messageId: `response-${String(body.messageId)}`,
      inReplyTo: body.messageId,
      requestId: body.requestId,
      ok: true,
      code: "SHOULD_NOT_EXIST",
      error: { code: "SHOULD_NOT_EXIST", message: "contradiction", retryability: "unsafe" },
      payload: { result: {} },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const knowledge = createKnowledgeModulePort(binding(
    "unknown.knowledge",
    "staffdeck.knowledge/v1",
    `http://127.0.0.1:${address.port}`,
    ["query"],
  ));

  await assert.rejects(
    () => knowledge.call("query", { query: "anything" }),
    (error: unknown) => (error as { code?: string }).code === "MODULE_PROTOCOL_INCOMPATIBLE",
  );
});

test("unknown skill and knowledge implementations perform domain operations", async (t) => {
  const calls: Array<{ implementationId: string; operation: string }> = [];
  const server = createServer(async (request, response) => domainRoute(request, response, calls));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const skills = createSkillModulePort(binding("unknown.skills", "pilotdeck.skills/v1", endpoint, ["list", "read"]));
  const knowledge = createKnowledgeModulePort(binding("unknown.knowledge", "staffdeck.knowledge/v1", endpoint, ["query"]));

  const listed = await skills.list({ projectKey: "/project" });
  assert.equal(listed[0]?.name, "approval-guide");
  assert.equal(await skills.read({ name: "approval-guide", projectKey: "/project" }), "# Approval Guide\nUse evidence.");

  const tool = createKnowledgeQueryTool(knowledge);
  const output = await tool.execute({ query: "approval" }, {} as never);
  assert.deepEqual(output.data, { hits: [{ id: "chunk-1", text: "Require approval.", citationId: "citation-1" }] });
  assert.deepEqual(calls, [
    { implementationId: "unknown.skills", operation: "list" },
    { implementationId: "unknown.skills", operation: "read" },
    { implementationId: "unknown.knowledge", operation: "query" },
  ]);
});

test("external Skill write disconnect after dispatch remains an unknown transport outcome", async (t) => {
  let writeCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.skills", "pilotdeck.skills/v1", ["write"]));
    writeCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const management = createSkillManagementPort(binding(
    "unknown.skills",
    "pilotdeck.skills/v1",
    `http://127.0.0.1:${address.port}`,
    ["write"],
  ));

  await assert.rejects(
    () => management.write({ scope: "project", slug: "approval-guide", projectKey: "/project", content: "# Updated" }),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TRANSPORT_UNAVAILABLE"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(writeCalls, 1, "a Skill write must not automatically replay after a disconnect");
});

test("external Knowledge import disconnect after dispatch remains an unknown transport outcome", async (t) => {
  let importCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return json(response, manifest("unknown.knowledge", "staffdeck.knowledge/v1", ["import_document"]));
    importCalls += 1;
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const knowledge = createKnowledgeModulePort(binding(
    "unknown.knowledge",
    "staffdeck.knowledge/v1",
    `http://127.0.0.1:${address.port}`,
    ["import_document"],
 ));

  await assert.rejects(
    () => knowledge.call("import_document", { baseId: "base-1", content: "approval policy" }),
    (error: unknown) => (error as { code?: string; outcome?: string }).code === "MODULE_TRANSPORT_UNAVAILABLE"
      && (error as { outcome?: string }).outcome === "result_unknown",
  );
  assert.equal(importCalls, 1, "a Knowledge import must not automatically replay after a disconnect");
});

test("unknown Skill module preserves the complete management surface and runtime projection", async (t) => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      return json(response, manifest("unknown.skills", "pilotdeck.skills/v1", [
        "list", "read", "create", "write", "delete", "validate", "import", "scan",
      ]));
    }
    const body = await readJson(request) as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    const operation = String(payload.operation);
    calls.push(operation);
    const result = operation === "list"
      ? {
          builtin: [],
          user: [],
          project: [],
          projectPath: "/project",
          items: [{ slug: "approval-guide", name: "Approval Guide", description: "Approval guidance", skillFile: "/external/approval-guide/SKILL.md" }],
        }
      : operation === "read"
        ? { content: "# Approval Guide\nUse a citation.", scope: "project", slug: "approval-guide", skill: null }
        : operation === "validate"
          ? { ok: true, hardFails: [], warnings: [], stats: { fileCount: 1, totalBytes: 32 }, frontmatter: null }
          : operation === "scan"
            ? { parentPath: "/project", folders: [] }
            : { ok: true, scope: "project", slug: "approval-guide", skill: null };
    json(response, envelope(body, result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const bindingValue = binding(
    "unknown.skills",
    "pilotdeck.skills/v1",
    `http://127.0.0.1:${address.port}`,
    ["list", "read", "create", "write", "delete", "validate", "import", "scan"],
  );
  const management = createSkillManagementPort(bindingValue);
  const runtime = createSkillModulePort(bindingValue);

  const managementList = await management.list({ projectKey: "/project" });
  assert.equal(managementList.items[0]?.slug, "approval-guide");
  const runtimeSkills = await runtime.list({ projectKey: "/project" });
  assert.equal(runtimeSkills[0]?.name, "approval-guide");
  assert.equal(runtimeSkills[0]?.path, "/external/approval-guide/SKILL.md");
  assert.equal(await runtime.read({ name: "approval-guide", projectKey: "/project" }), "# Approval Guide\nUse a citation.");
  assert.equal((await management.read({ scope: "project", slug: "approval-guide", projectKey: "/project" })).content, "# Approval Guide\nUse a citation.");
  await management.create({ scope: "project", slug: "approval-guide", projectKey: "/project" });
  await management.write({ scope: "project", slug: "approval-guide", projectKey: "/project", content: "# Updated" });
  await management.delete({ scope: "project", slug: "approval-guide", projectKey: "/project" });
  assert.equal((await management.validate({ sourcePath: "/project/approval-guide" })).ok, true);
  await management.import({ scope: "project", slug: "approval-guide", projectKey: "/project", sourcePath: "/source" });
  assert.deepEqual(await management.scan({ parentPath: "/project" }), { parentPath: "/project", folders: [] });
  assert.deepEqual(calls, ["list", "list", "read", "read", "create", "write", "delete", "validate", "import", "scan"]);
});

test("unknown Knowledge module preserves the declared management and citation surface", async (t) => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const operations = [
    "list_bases", "create_base", "get_base", "update_base", "delete_base", "list_versions",
    "sync_base", "publish_version", "rollback_version", "list_documents", "get_document",
    "import_document", "import_okf", "update_document", "delete_document", "list_document_buckets",
    "update_bucket", "list_bucket_chunks", "update_chunk", "get_job", "list_jobs", "cancel_job",
    "list_okf_concepts", "get_okf_concept", "upsert_okf_concept", "export_okf", "lint_okf",
    "list_discoveries", "confirm_discovery", "reject_discovery", "query", "resolve_citation",
  ];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      return json(response, manifest("unknown.knowledge", "staffdeck.knowledge/v1", operations));
    }
    const body = await readJson(request) as Record<string, unknown>;
    const payload = body.payload as Record<string, unknown>;
    const operation = String(payload.operation);
    calls.push({ operation, input: payload.input as Record<string, unknown> });
    return json(response, envelope(body, { operation, accepted: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  const knowledge = createKnowledgeModulePort(binding(
    "unknown.knowledge",
    "staffdeck.knowledge/v1",
    `http://127.0.0.1:${address.port}`,
    operations,
  ));

  for (const operation of operations) {
    const input = { tenantId: "tenant-1", operation };
    assert.deepEqual(await knowledge.call(operation, input), { operation, accepted: true });
  }
  assert.deepEqual(calls, operations.map((operation) => ({
    operation,
    input: { tenantId: "tenant-1", operation },
  })));
});

function binding(implementationId: string, contract: string, endpoint: string, methods: string[]): ExternalModuleBinding {
  return {
    enabled: true,
    implementationId,
    contract,
    transport: "module-http-v2",
    endpoint,
    manifestPath: `/manifest/${implementationId}`,
    callPath: `/call/${implementationId}`,
    methods,
  };
}

function toolContext(sessionId: string) {
  return {
    sessionId,
    turnId: "turn",
    cwd: "/tmp",
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for module dispatch.");
    await delay(5);
  }
}

async function route(request: IncomingMessage, response: ServerResponse, calls: Array<{ implementationId: string; operation: string }>) {
  const implementationId = request.url?.split("/").at(-1) ?? "";
  const contracts: Record<string, string> = {
    "unknown.model": "pilotdeck.model/v1",
    "unknown.tools": "pilotdeck.tools/v1",
    "unknown.context": "pilotdeck.context/v1",
  };
  const methods: Record<string, string[]> = {
    "unknown.model": ["prepare", "stream"],
    "unknown.tools": ["execute"],
    "unknown.context": ["prepare_for_model"],
  };
  if (request.method === "GET") return json(response, manifest(implementationId, contracts[implementationId]!, methods[implementationId]!));
  const body = await readJson(request) as Record<string, unknown>;
  const payload = body.payload as Record<string, unknown>;
  const operation = implementationId === "unknown.tools" ? "execute" : String(payload.operation ?? "");
  calls.push({ implementationId, operation });
  let result: Record<string, unknown>;
  if (implementationId === "unknown.model" && operation === "prepare") {
    result = { prepared: { request: payload.request, provider: "remote", model: "m" } };
  } else if (implementationId === "unknown.model") {
    result = { events: [{ type: "message_end", finishReason: "stop" }] };
  } else if (implementationId === "unknown.tools") {
    result = { type: "success", toolCallId: payload.toolCallId, toolName: payload.name, content: [{ type: "text", text: "remote" }] };
  } else {
    result = { result: { messages: [], systemPromptParts: ["external context"], tools: [], diagnostics: [], boundaries: [] } };
  }
  json(response, {
    kind: "response",
    messageId: `response-${String(body.messageId)}`,
    inReplyTo: body.messageId,
    requestId: body.requestId,
    ok: true,
    payload: result,
  });
}

async function domainRoute(request: IncomingMessage, response: ServerResponse, calls: Array<{ implementationId: string; operation: string }>) {
  const implementationId = request.url?.split("/").at(-1) ?? "";
  const contract = implementationId === "unknown.skills" ? "pilotdeck.skills/v1" : "staffdeck.knowledge/v1";
  const methods = implementationId === "unknown.skills" ? ["list", "read"] : ["query"];
  if (request.method === "GET") return json(response, manifest(implementationId, contract, methods));
  const body = await readJson(request) as Record<string, unknown>;
  const payload = body.payload as Record<string, unknown>;
  const operation = String(payload.operation);
  calls.push({ implementationId, operation });
  const result = implementationId === "unknown.skills"
    ? operation === "list"
      ? [{ name: "approval-guide", description: "Approval guidance", path: "module://unknown.skills/approval-guide" }]
      : "# Approval Guide\nUse evidence."
    : { hits: [{ id: "chunk-1", text: "Require approval.", citationId: "citation-1" }] };
  json(response, {
    kind: "response",
    messageId: `response-${String(body.messageId)}`,
    inReplyTo: body.messageId,
    requestId: body.requestId,
    ok: true,
    payload: { result },
  });
}

function manifest(implementationId: string, contract: string, methods: string[]) {
  return { protocolVersion: "2.0", implementationId, contract, transport: "module-http-v2", methods };
}

function envelope(request: Record<string, unknown>, result: unknown) {
  return {
    kind: "response",
    messageId: `response-${String(request.messageId)}`,
    inReplyTo: request.messageId,
    requestId: request.requestId,
    ok: true,
    payload: { result },
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
