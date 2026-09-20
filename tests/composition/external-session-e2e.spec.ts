import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

test("Gateway runs a turn through external Model, Tool, Context, Skill, and Knowledge modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-external-core-session-"));
  const projectRoot = join(root, "project");
  const calls: string[] = [];
  const moduleServer = createServer(async (request, response) => {
    const path = request.url ?? "";
    const slot = path.includes("model")
      ? "modelProvider"
      : path.includes("tools")
        ? "tools"
        : path.includes("skills")
          ? "skills"
          : path.includes("knowledge")
            ? "knowledge"
            : "context";
    const implementationId = `example.${slot}`;
    const contract = slot === "modelProvider"
      ? "pilotdeck.model/v1"
      : slot === "tools" ? "pilotdeck.tools/v1"
        : slot === "skills" ? "pilotdeck.skills/v1"
          : slot === "knowledge" ? "staffdeck.knowledge/v1"
            : "pilotdeck.context/v1";
    const methods = slot === "modelProvider"
      ? ["prepare", "stream"]
      : slot === "tools" ? ["execute"]
        : slot === "skills" ? ["list", "read"]
          : slot === "knowledge" ? ["query"] : ["prepare_for_model"];
    if (request.method === "GET") {
      writeJson(response, { protocolVersion: "2.0", implementationId, contract, transport: "module-http-v2", methods });
      return;
    }
    const body = await readJson(request);
    const payload = body.payload as Record<string, unknown>;
    const operation = String(payload.operation ?? (slot === "tools" ? "execute" : ""));
    calls.push(`${slot}:${operation}`);
    let result: unknown;
    if (slot === "skills" && operation === "list") {
      result = {
        builtin: [],
        user: [],
        project: [],
        projectPath: projectRoot,
        items: [{
          slug: "approval-guide",
          name: "Approval Guide",
          description: "Approval guidance",
          skillFile: "/external/approval-guide/SKILL.md",
        }],
      };
    } else if (slot === "skills" && operation === "read") {
      result = {
        content: "# Approval Guide\n\nUse a citation for every approval.",
        scope: "project",
        slug: "approval-guide",
        skill: null,
      };
    } else if (slot === "knowledge" && operation === "query") {
      result = { hits: [{ id: "chunk-1", text: "Approval requires evidence.", citationId: "citation-1" }] };
    } else if (slot === "modelProvider" && operation === "prepare") {
      result = { prepared: { request: payload.request, provider: "remote", model: "default" } };
    } else if (slot === "modelProvider" && operation === "stream") {
      const requestPayload = payload.request as Record<string, unknown>;
      const hasToolResult = JSON.stringify(requestPayload.messages ?? []).includes("tool_result");
      result = {
        events: hasToolResult
          ? [
              { type: "request_started", provider: "remote", model: "default" },
              { type: "message_start", role: "assistant" },
              { type: "text_delta", text: "External core modules completed." },
              { type: "message_end", finishReason: "stop" },
            ]
          : [
              { type: "request_started", provider: "remote", model: "default" },
              { type: "message_start", role: "assistant" },
              { type: "tool_call_start", id: "external-skill-call", name: "read_skill" },
              { type: "tool_call_end", toolCall: { id: "external-skill-call", name: "read_skill", input: { skillName: "approval-guide" } } },
              { type: "tool_call_start", id: "external-tool-call", name: "remote_lookup" },
              { type: "tool_call_end", toolCall: { id: "external-tool-call", name: "remote_lookup", input: { key: "approval" } } },
              { type: "tool_call_start", id: "external-knowledge-call", name: "knowledge_query" },
              { type: "tool_call_end", toolCall: { id: "external-knowledge-call", name: "knowledge_query", input: { query: "approval evidence" } } },
              { type: "message_end", finishReason: "tool_call" },
            ],
      };
    } else if (slot === "tools") {
      result = {
        type: "success",
        toolCallId: payload.toolCallId,
        toolName: payload.name,
        content: [{ type: "text", text: "remote lookup result" }],
        startedAt: "2026-09-18T00:00:00.000Z",
        completedAt: "2026-09-18T00:00:00.001Z",
      };
    } else {
      const input = payload.input as Record<string, unknown>;
      result = {
        messages: input.messages ?? [],
        systemPromptParts: [],
        tools: input.tools ?? [],
        diagnostics: [],
        boundaries: [],
      };
    }
    const responsePayload = ["context", "skills", "knowledge"].includes(slot) ? { result } : result;
    writeJson(response, {
      kind: "response",
      messageId: `response-${String(body.messageId)}`,
      inReplyTo: body.messageId,
      requestId: body.requestId,
      ok: true,
      payload: responsePayload,
    });
  });
  await new Promise<void>((resolve) => moduleServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => moduleServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = moduleServer.address();
  if (!address || typeof address === "string") throw new Error("module server has no TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: remote/default
model:
  providers:
    remote:
      protocol: openai
      url: http://provider.invalid/v1
      apiKey: test-only
      models:
        default: {}
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider:
    enabled: true
    implementationId: example.modelProvider
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/model
    callPath: /call/model
    methods: [prepare, stream]
  tools:
    enabled: true
    implementationId: example.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/tools
    callPath: /call/tools
    methods: [execute]
    catalog:
      - name: remote_lookup
        description: Look up an approval record.
        inputSchema: { type: object }
        readOnly: true
        concurrencySafe: true
  context:
    enabled: true
    implementationId: example.context
    contract: pilotdeck.context/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/context
    callPath: /call/context
    methods: [prepare_for_model]
  skills:
    enabled: true
    implementationId: example.skills
    contract: pilotdeck.skills/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/skills
    callPath: /call/skills
    methods: [list, read]
  knowledge:
    enabled: true
    implementationId: example.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/knowledge
    callPath: /call/knowledge
    methods: [query]
`, "utf8");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    const listedSkills = await local.gateway.skillsList!({ projectKey: projectRoot });
    assert.equal(listedSkills.items[0]?.slug, "approval-guide");
    const readSkill = await local.gateway.skillRead!({
      scope: "project",
      slug: "approval-guide",
      projectKey: projectRoot,
    });
    assert.match(readSkill.content, /citation/);
    const events: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "external-core-session",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Look up the approval record.",
      mode: "bypassPermissions",
    })) events.push(event);
    const evidence = JSON.stringify({ calls, events });
    assert.ok(calls.includes("modelProvider:prepare"), evidence);
    assert.ok(calls.includes("modelProvider:stream"), evidence);
    assert.ok(calls.includes("tools:execute"), evidence);
    assert.ok(calls.includes("context:prepare_for_model"), evidence);
    assert.ok(calls.includes("skills:list"), evidence);
    assert.ok(calls.includes("skills:read"), evidence);
    assert.ok(calls.includes("knowledge:query"), evidence);
    assert.match(JSON.stringify(events), /External core modules completed/);
  } finally {
    await local.dispose();
  }
});

test("plain profile with disabled Skill and Knowledge modules does not expose their session tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-disabled-skill-session-"));
  const projectRoot = join(root, "project");
  const calls: string[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const moduleServer = createServer(async (request, response) => {
    if (request.method === "GET") {
      writeJson(response, {
        protocolVersion: "2.0",
        implementationId: "example.modelProvider",
        contract: "pilotdeck.model/v1",
        transport: "module-http-v2",
        methods: ["prepare", "stream"],
      });
      return;
    }
    const body = await readJson(request);
    const payload = body.payload as Record<string, unknown>;
    const operation = String(payload.operation);
    calls.push(operation);
    if (operation === "prepare") {
      const requestPayload = payload.request as Record<string, unknown>;
      modelRequests.push(requestPayload);
      writeJson(response, moduleResponse(body, {
        prepared: { request: requestPayload, provider: "remote", model: "default" },
      }));
      return;
    }
    if (operation === "stream") {
      const requestPayload = payload.request as Record<string, unknown>;
      modelRequests.push(requestPayload);
      writeJson(response, moduleResponse(body, {
        events: [
          { type: "request_started", provider: "remote", model: "default" },
          { type: "message_start", role: "assistant" },
          { type: "text_delta", text: "Skills are disabled." },
          { type: "message_end", finishReason: "stop" },
        ],
      }));
      return;
    }
    response.writeHead(400).end();
  });
  await new Promise<void>((resolve) => moduleServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => moduleServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = moduleServer.address();
  if (!address || typeof address === "string") throw new Error("module server has no TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: remote/default
model:
  providers:
    remote:
      protocol: openai
      url: http://provider.invalid/v1
      apiKey: test-only
      models:
        default: {}
modules:
  modelProvider:
    enabled: true
    implementationId: example.modelProvider
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/model
    callPath: /call/model
    methods: [prepare, stream]
  skills: { enabled: false }
  knowledge: { enabled: false }
`, "utf8");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    const events: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "disabled-skill-session",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Confirm the available tools.",
      mode: "bypassPermissions",
    })) events.push(event);

    const toolNames = modelRequests.flatMap((request) => Array.isArray(request.tools)
      ? request.tools.map((tool) => String((tool as Record<string, unknown>).name))
      : []);
    assert.ok(calls.includes("prepare"), JSON.stringify({ calls, modelRequests }));
    assert.ok(calls.includes("stream"), JSON.stringify({ calls, modelRequests }));
    assert.ok(modelRequests.length > 0, JSON.stringify({ calls, modelRequests }));
    assert.equal(toolNames.includes("read_skill"), false, JSON.stringify({ calls, modelRequests }));
    assert.equal(toolNames.includes("knowledge_query"), false, JSON.stringify({ calls, modelRequests }));
    assert.match(JSON.stringify(events), /Skills are disabled/);
  } finally {
    await local.dispose();
  }
});

test("Knowledge-only profile runs a live Gateway turn without Skill or SOP fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-knowledge-only-session-"));
  const projectRoot = join(root, "project");
  const modelRequests: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const moduleServer = createServer(async (request, response) => {
    const isKnowledge = (request.url ?? "").includes("knowledge");
    if (request.method === "GET") {
      writeJson(response, isKnowledge
        ? { protocolVersion: "2.0", implementationId: "example.knowledge", contract: "staffdeck.knowledge/v1", transport: "module-http-v2", methods: ["query"] }
        : { protocolVersion: "2.0", implementationId: "example.modelProvider", contract: "pilotdeck.model/v1", transport: "module-http-v2", methods: ["prepare", "stream"] });
      return;
    }
    const body = await readJson(request);
    const payload = body.payload as Record<string, unknown>;
    const operation = isKnowledge ? "query" : String(payload.operation);
    calls.push(`${isKnowledge ? "knowledge" : "modelProvider"}:${operation}`);
    if (isKnowledge) {
      writeJson(response, moduleResponse(body, { result: { hits: [{ id: "chunk-1", text: "Approval requires evidence.", citationId: "citation-1" }] } }));
      return;
    }
    if (operation === "prepare") {
      const requestPayload = payload.request as Record<string, unknown>;
      modelRequests.push(requestPayload);
      writeJson(response, moduleResponse(body, { prepared: { request: requestPayload, provider: "remote", model: "default" } }));
      return;
    }
    const requestPayload = payload.request as Record<string, unknown>;
    modelRequests.push(requestPayload);
    const hasKnowledge = JSON.stringify(requestPayload.messages ?? []).includes("tool_result");
    writeJson(response, moduleResponse(body, {
      events: hasKnowledge
        ? [
            { type: "request_started", provider: "remote", model: "default" },
            { type: "message_start", role: "assistant" },
            { type: "text_delta", text: "Knowledge-only profile completed." },
            { type: "message_end", finishReason: "stop" },
          ]
        : [
            { type: "request_started", provider: "remote", model: "default" },
            { type: "message_start", role: "assistant" },
            { type: "tool_call_start", id: "knowledge-call", name: "knowledge_query" },
            { type: "tool_call_end", toolCall: { id: "knowledge-call", name: "knowledge_query", input: { query: "approval evidence" } } },
            { type: "message_end", finishReason: "tool_call" },
          ],
    }));
  });
  await new Promise<void>((resolve) => moduleServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => moduleServer.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = moduleServer.address();
  if (!address || typeof address === "string") throw new Error("module server has no TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: remote/default
model:
  providers:
    remote:
      protocol: openai
      url: http://provider.invalid/v1
      apiKey: test-only
      models:
        default: {}
modules:
  modelProvider:
    enabled: true
    implementationId: example.modelProvider
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/model
    callPath: /call/model
    methods: [prepare, stream]
  skills: { enabled: false }
  knowledge:
    enabled: true
    implementationId: example.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: ${endpoint}
    manifestPath: /manifest/knowledge
    callPath: /call/knowledge
    methods: [query]
`, "utf8");

  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  try {
    const events: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "knowledge-only-session",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Find approval evidence.",
      mode: "bypassPermissions",
    })) events.push(event);
    const toolNames = modelRequests.flatMap((request) => Array.isArray(request.tools)
      ? request.tools.map((tool) => String((tool as Record<string, unknown>).name))
      : []);
    assert.ok(calls.includes("knowledge:query"), JSON.stringify({ calls, events }));
    assert.equal(toolNames.includes("knowledge_query"), true, JSON.stringify(modelRequests));
    assert.equal(toolNames.includes("read_skill"), false, JSON.stringify(modelRequests));
    assert.match(JSON.stringify(events), /Knowledge-only profile completed/);
  } finally {
    await local.dispose();
  }
});

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function moduleResponse(body: Record<string, unknown>, payload: unknown): Record<string, unknown> {
  return {
    kind: "response",
    messageId: `response-${String(body.messageId)}`,
    inReplyTo: body.messageId,
    requestId: body.requestId,
    ok: true,
    payload,
  };
}
