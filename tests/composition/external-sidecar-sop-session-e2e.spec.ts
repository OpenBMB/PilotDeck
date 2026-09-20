import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
} from "../../src/agent/index.js";
import { createSidecarExecution } from "../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createKnowledgeModulePort } from "../../src/composition/domainPorts.js";

const KNOWLEDGE_METHODS = [
  "list_bases",
  "create_base",
  "get_base",
  "update_base",
  "delete_base",
  "list_versions",
  "sync_base",
  "publish_version",
  "rollback_version",
  "list_documents",
  "get_document",
  "import_document",
  "import_okf",
  "update_document",
  "delete_document",
  "list_document_buckets",
  "update_bucket",
  "list_bucket_chunks",
  "update_chunk",
  "get_job",
  "list_jobs",
  "cancel_job",
  "list_okf_concepts",
  "get_okf_concept",
  "upsert_okf_concept",
  "export_okf",
  "lint_okf",
  "list_discoveries",
  "confirm_discovery",
  "reject_discovery",
  "query",
  "resolve_citation",
] as const;

/**
 * The sidecar is selected by modules.agentLoop, while every other owner is
 * selected by the same YAML profile. This exercises the real Gateway/session
 * composition boundary rather than calling the individual Ports directly.
 */
test("YAML-composed external AgentLoop runs SOP with external core modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-external-sidecar-sop-"));
  const projectRoot = join(root, "project");
  const moduleCalls: string[] = [];
  const sopCalls: string[] = [];
  let automaticCompactionReturned = false;
  let manualCompactionReturned = false;
  let waitMode = false;
  let waitSubmitted = false;
  let waitPhase: "idle" | "handoff" | "handoff_submitted" | "completed" | "completed_submitted" = "idle";
  let enableKnowledgeFault = false;
  let releaseKnowledgeFault!: () => void;
  let signalKnowledgeFault!: () => void;
  const knowledgeFaultReleased = new Promise<void>((resolve) => { releaseKnowledgeFault = resolve; });
  const knowledgeFaultReached = new Promise<void>((resolve) => { signalKnowledgeFault = resolve; });
  const modelRequests: Record<string, unknown>[] = [];
  const moduleServer = createServer(async (request, response) => {
    await routeModule(request, response, moduleCalls, projectRoot, {
      consumeAutomaticCompaction: () => {
        if (automaticCompactionReturned) return false;
        automaticCompactionReturned = true;
        return true;
      },
      consumeManualCompaction: () => {
        if (manualCompactionReturned) return false;
        manualCompactionReturned = true;
        return true;
      },
      nextSubmission: () => {
        if (!waitMode) return undefined;
        if (waitPhase === "handoff") {
          waitPhase = "handoff_submitted";
          waitSubmitted = true;
          return { status: "handoff", replyFragment: "External sidecar waiting for approval." };
        }
        if (waitPhase === "completed") {
          waitPhase = "completed_submitted";
          return { status: "completed", replyFragment: "External sidecar resumed and completed." };
        }
        return undefined;
      },
      modelRequests,
      knowledgeFault: {
        enabled: () => enableKnowledgeFault,
        reached: signalKnowledgeFault,
        released: knowledgeFaultReleased,
      },
    });
  });
  const sopServer = createServer(async (request, response) => {
    await routeSop(request, response, sopCalls, {
      isHandoffSession: (sessionId) => sessionId === "external-sidecar-wait",
    });
  });
  await listen(moduleServer);
  await listen(sopServer);
  const moduleEndpoint = serverUrl(moduleServer);
  const sopEndpoint = serverUrl(sopServer);
  let sidecar = new AgentLoopSidecarTcpServer(
    new AgentLoopSidecarServer(async (input) => createSidecarExecution(input), {
      moduleId: "pilotdeck-agent-loop",
    }),
  );
  const sidecarAddress = await sidecar.listen({ host: "127.0.0.1", port: 0 });

  const restartSidecar = async (): Promise<void> => {
    await sidecar.close();
    sidecar = new AgentLoopSidecarTcpServer(
      new AgentLoopSidecarServer(async (input) => createSidecarExecution(input), {
        moduleId: "pilotdeck-agent-loop",
      }),
    );
    await sidecar.listen({ host: sidecarAddress.host, port: sidecarAddress.port });
  };

  t.after(async () => {
    await sidecar.close();
    await closeServer(moduleServer);
    await closeServer(sopServer);
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval.yaml"), `
sops:
  - id: approval
    name: Approval
    content:
      start_node_id: only
      nodes:
        - node_id: only
          instruction: Read the approval guide and knowledge record.
          allowed_actions:
            - call_tool:remote_lookup
            - call_tool:knowledge_query
`, "utf8");
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
        default:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 65536
            maxOutputTokens: 8192
modules:
  agentLoop:
    enabled: true
    implementationId: pilotdeck-agent-loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: ${sidecarAddress.host}
    port: ${sidecarAddress.port}
    methods: [execute, status, resume, ack]
  modelProvider:
    enabled: true
    implementationId: example.modelProvider
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: ${moduleEndpoint}
    manifestPath: /manifest/modelProvider
    callPath: /call/modelProvider
    methods: [prepare, stream]
  tools:
    enabled: true
    implementationId: example.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: ${moduleEndpoint}
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
    endpoint: ${moduleEndpoint}
    manifestPath: /manifest/context
    callPath: /call/context
    methods: [prepare_for_model, apply_tool_results, recover_from_model_error, capture_turn, try_auto_compact]
  skills:
    enabled: true
    implementationId: example.skills
    contract: pilotdeck.skills/v1
    transport: module-http-v2
    endpoint: ${moduleEndpoint}
    manifestPath: /manifest/skills
    callPath: /call/skills
    methods: [list, read]
  knowledge:
    enabled: true
    implementationId: example.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: ${moduleEndpoint}
    manifestPath: /manifest/knowledge
    callPath: /call/knowledge
    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]
  sop:
    enabled: true
    implementationId: example.sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: ${sopEndpoint}
    manifestPath: /manifest/sop
    definitionsPath: approval.yaml
    defaultSopId: approval
`, "utf8");

  const knowledge = createKnowledgeModulePort({
    enabled: true,
    implementationId: "example.knowledge",
    contract: "staffdeck.knowledge/v1",
    transport: "module-http-v2",
    endpoint: moduleEndpoint,
    manifestPath: "/manifest/knowledge",
    callPath: "/call/knowledge",
    methods: KNOWLEDGE_METHODS,
  });
  for (const operation of KNOWLEDGE_METHODS) {
    const expected = operation === "query"
      ? { hits: [{ id: "chunk-1", text: "Approval requires evidence.", citationId: "citation-1" }] }
      : { operation, accepted: true };
    assert.deepEqual(
      await knowledge.call(operation, { tenantId: "tenant-1", operation }),
      expected,
    );
  }

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  t.after(() => local.dispose());

  const events: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "external-sidecar-sop",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: "Complete the approval check.",
    mode: "bypassPermissions",
  })) events.push(event);

  const evidence = JSON.stringify({ moduleCalls, sopCalls, events });
  assert.ok(moduleCalls.includes("skills:list"), evidence);
  assert.ok(moduleCalls.includes("skills:read"), evidence);
  for (const operation of KNOWLEDGE_METHODS) {
    assert.ok(moduleCalls.includes(`knowledge:${operation}`), evidence);
  }
  assert.ok(moduleCalls.includes("context:prepare_for_model"), evidence);
  assert.ok(moduleCalls.includes("context:try_auto_compact"), evidence);
  assert.ok(moduleCalls.includes("context:apply_tool_results"), evidence);
  assert.ok(moduleCalls.includes("context:capture_turn"), evidence);
  assert.ok(moduleCalls.includes("modelProvider:prepare"), evidence);
  assert.ok(moduleCalls.includes("modelProvider:stream"), evidence);
  assert.ok(moduleCalls.includes("tools:execute"), evidence);
  assert.deepEqual(sopCalls, ["prepare", "prepare", "prepare", "prepare", "submit"], evidence);
  assert.match(JSON.stringify(events), /External sidecar SOP completed/);
  assert.ok(moduleCalls.filter((call) => call === "context:try_auto_compact").length >= 2, evidence);
  assert.match(JSON.stringify(events), /auto_compact/, evidence);

  const automaticArchive = await local.gateway.exportSessionTranscript!({
    projectKey: projectRoot,
    sessionKey: "external-sidecar-sop",
  });
  assert.ok(
    automaticArchive.messages.some((message) => message.text.includes("External automatic compaction summary")),
    JSON.stringify(automaticArchive),
  );

  waitMode = true;
  waitPhase = "handoff";
  const waitingEvents: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "external-sidecar-wait",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: "Request external approval.",
    mode: "bypassPermissions",
  })) waitingEvents.push(event);
  assert.match(JSON.stringify(waitingEvents), /External sidecar waiting for approval/);
  assert.equal(waitSubmitted, true);
  const waiting = await local.gateway.sopStatus!({
    sessionKey: "external-sidecar-wait",
    projectKey: projectRoot,
  });
  assert.equal(waiting?.state.status, "handoff", JSON.stringify(waiting));
  assert.equal(waiting?.wait?.kind, "handoff", JSON.stringify(waiting));

  await restartSidecar();
  const resumed = await local.gateway.resumeSop!({
    sessionKey: "external-sidecar-wait",
    projectKey: projectRoot,
    requestId: "external-sidecar-resume-1",
    waitId: waiting!.wait!.id,
    source: "human",
    message: "Human approved the external request.",
    expectedRevision: waiting!.revision,
    slotUpdates: { approved: true },
  });
  const duplicateResume = await local.gateway.resumeSop!({
    sessionKey: "external-sidecar-wait",
    projectKey: projectRoot,
    requestId: "external-sidecar-resume-1",
    waitId: waiting!.wait!.id,
    source: "human",
    message: "Human approved the external request.",
  });
  assert.equal(resumed.duplicate, false, JSON.stringify(resumed));
  assert.equal(duplicateResume.duplicate, true, JSON.stringify(duplicateResume));
  waitPhase = "completed";
  const resumedEvents: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "external-sidecar-wait",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: resumed.message,
    mode: "bypassPermissions",
  })) resumedEvents.push(event);
  assert.match(JSON.stringify(resumedEvents), /External sidecar resumed and completed/);
  const resumedState = await local.gateway.sopStatus!({
    sessionKey: "external-sidecar-wait",
    projectKey: projectRoot,
  });
  assert.equal(resumedState?.state.status, "completed", JSON.stringify(resumedState));

  const rpcFailureEvents: unknown[] = [];
  enableKnowledgeFault = true;
  const rpcFailureTurn = (async () => {
    for await (const event of local.gateway.submitTurn({
      sessionKey: "external-sidecar-rpc-failure",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Run the approval check despite a knowledge RPC fault.",
      mode: "bypassPermissions",
    })) rpcFailureEvents.push(event);
  })();
  await knowledgeFaultReached;
  const rpcStateBefore = await local.gateway.sopStatus!({
    sessionKey: "external-sidecar-rpc-failure",
    projectKey: projectRoot,
  });
  const rpcJournalPath = join(
    projectRoot,
    "sop",
    "sessions",
    `${Buffer.from("external-sidecar-rpc-failure").toString("base64url")}.json`,
  );
  const rpcJournalBefore = await readFile(rpcJournalPath, "utf8");
  assert.equal(rpcStateBefore?.state.status, "active", JSON.stringify(rpcStateBefore));
  assert.equal(rpcStateBefore?.wait, undefined, JSON.stringify(rpcStateBefore));

  releaseKnowledgeFault();
  await rpcFailureTurn;

  const rpcStateAfter = await local.gateway.sopStatus!({
    sessionKey: "external-sidecar-rpc-failure",
    projectKey: projectRoot,
  });
  const rpcJournalAfter = await readFile(rpcJournalPath, "utf8");
  const journalBefore = JSON.parse(rpcJournalBefore) as { state?: { status?: string; awaiting_input_json?: unknown } };
  const journalAfter = JSON.parse(rpcJournalAfter) as { state?: { status?: string; awaiting_input_json?: unknown } };
  assert.equal(rpcStateAfter?.state.status, rpcStateBefore?.state.status, JSON.stringify({ rpcStateBefore, rpcStateAfter, rpcFailureEvents }));
  assert.equal(rpcStateAfter?.wait, rpcStateBefore?.wait, JSON.stringify({ rpcStateBefore, rpcStateAfter }));
  assert.deepEqual(rpcStateAfter?.state.successful_tool_names, ["read_skill", "remote_lookup"]);
  assert.equal(journalAfter.state?.status, journalBefore.state?.status, `${rpcJournalBefore}\n${rpcJournalAfter}`);
  assert.deepEqual(journalAfter.state?.awaiting_input_json, journalBefore.state?.awaiting_input_json);
  assert.ok(
    modelRequests.some((request) => JSON.stringify(request.messages ?? []).includes("Successful module response contains failure fields.")),
    JSON.stringify({ modelRequests, rpcFailureEvents }),
  );
  assert.equal(
    sopCalls.filter((call) => call === "submit").length,
    3,
    JSON.stringify({ sopCalls, rpcFailureEvents }),
  );

  const manualEvents: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "external-sidecar-sop",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: "/compact",
    mode: "bypassPermissions",
  })) manualEvents.push(event);
  assert.match(JSON.stringify(manualEvents), /Compacted 1 history items/, JSON.stringify(manualEvents));
  assert.ok(moduleCalls.filter((call) => call === "context:try_auto_compact").length >= 3, JSON.stringify(moduleCalls));

  const manualArchive = await local.gateway.exportSessionTranscript!({
    projectKey: projectRoot,
    sessionKey: "external-sidecar-sop",
  });
  assert.ok(
    manualArchive.messages.some((message) => message.text.includes("External manual compaction summary")),
    JSON.stringify(manualArchive),
  );
  const state = JSON.parse(await readFile(
    join(projectRoot, "sop", "sessions", `${Buffer.from("external-sidecar-sop").toString("base64url")}.json`),
    "utf8",
  )) as { state?: { status?: string } };
  assert.equal(state.state?.status, "completed");
});

test("SOP-only profile enters a live handoff without Skill or Knowledge fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-only-session-"));
  const projectRoot = join(root, "project");
  const moduleCalls: string[] = [];
  const sopCalls: string[] = [];
  let submitted = false;
  const moduleServer = createServer(async (request, response) => {
    await routeModule(request, response, moduleCalls, projectRoot, {
      consumeAutomaticCompaction: () => false,
      consumeManualCompaction: () => false,
      nextSubmission: () => {
        if (submitted) return undefined;
        submitted = true;
        return { status: "handoff", replyFragment: "SOP-only profile waiting for approval." };
      },
    });
  });
  const sopServer = createServer(async (request, response) => {
    await routeSop(request, response, sopCalls, { isHandoffSession: (sessionId) => sessionId === "sop-only-session" });
  });
  await listen(moduleServer);
  await listen(sopServer);
  t.after(async () => {
    await closeServer(moduleServer);
    await closeServer(sopServer);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval.yaml"), `
sops:
  - id: approval
    name: Approval
    content:
      start_node_id: only
      nodes:
        - node_id: only
          instruction: Request a human approval.
          allowed_actions: []
`, "utf8");
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
    endpoint: ${serverUrl(moduleServer)}
    manifestPath: /manifest/modelProvider
    callPath: /call/modelProvider
    methods: [prepare, stream]
  skills: { enabled: false }
  knowledge: { enabled: false }
  sop:
    enabled: true
    implementationId: example.sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: ${serverUrl(sopServer)}
    manifestPath: /manifest/sop
    definitionsPath: approval.yaml
    defaultSopId: approval
`, "utf8");

  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  t.after(() => local.dispose());
  const events: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "sop-only-session",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: "Request approval.",
    mode: "bypassPermissions",
  })) events.push(event);
  const evidence = JSON.stringify({ moduleCalls, sopCalls, events });
  assert.equal(sopCalls.filter((call) => call === "prepare").length >= 1, true, evidence);
  assert.equal(sopCalls.filter((call) => call === "submit").length, 1, evidence);
  assert.equal(sopCalls.at(-1), "submit", evidence);
  assert.ok(moduleCalls.includes("modelProvider:prepare"), evidence);
  assert.ok(moduleCalls.includes("modelProvider:stream"), evidence);
  assert.equal(moduleCalls.some((call) => call.startsWith("skills:") || call.startsWith("knowledge:")), false, evidence);
  assert.match(evidence, /SOP-only profile waiting for approval/);
  const state = await local.gateway.sopStatus!({ sessionKey: "sop-only-session", projectKey: projectRoot });
  assert.equal(state?.state.status, "handoff", JSON.stringify(state));
});

test("Gateway rejects an SOP-required Tool that the selected profile does not bind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-required-tool-"));
  const projectRoot = join(root, "project");
  const sopCalls: string[] = [];
  const sopServer = createServer(async (request, response) => {
    await routeSop(request, response, sopCalls, { isHandoffSession: () => false });
  });
  await listen(sopServer);
  t.after(async () => {
    await closeServer(sopServer);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval.yaml"), `
sops:
  - id: approval
    name: Approval
    content:
      start_node_id: only
      nodes:
        - node_id: only
          instruction: This requires a profile-specific business tool.
          allowed_actions: [call_tool:lookup_approval_record]
`, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), `
schemaVersion: 1
agent:
  model: remote/default
model:
  providers:
    remote:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: test-only
      models:
        default: {}
modules:
  skills: { enabled: false }
  knowledge: { enabled: false }
  sop:
    enabled: true
    implementationId: example.sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: ${serverUrl(sopServer)}
    manifestPath: /manifest/sop
    definitionsPath: approval.yaml
    defaultSopId: approval
`, "utf8");

  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  t.after(() => local.dispose());
  const events: unknown[] = [];
  for await (const event of local.gateway.submitTurn({
    sessionKey: "required-tool-session",
    workspaceCwd: projectRoot,
    channelKey: "test",
    message: "Try the unavailable action.",
    mode: "bypassPermissions",
  })) events.push(event);
  const evidence = JSON.stringify({ events, sopCalls });
  assert.match(evidence, /gateway_submit_failed/);
  assert.match(evidence, /lookup_approval_record/);
  assert.deepEqual(sopCalls, [], evidence);
  const state = await local.gateway.sopStatus!({ sessionKey: "required-tool-session", projectKey: projectRoot });
  assert.equal(state, null, JSON.stringify({ state, events, sopCalls }));
});

async function routeModule(
  request: IncomingMessage,
  response: ServerResponse,
  calls: string[],
  projectRoot: string,
  compaction: {
    consumeAutomaticCompaction(): boolean;
    consumeManualCompaction(): boolean;
    nextSubmission(): { status: "completed" | "handoff"; replyFragment: string } | undefined;
    modelRequests?: Record<string, unknown>[];
    knowledgeFault?: {
      enabled(): boolean;
      reached(): void;
      released: Promise<void>;
    };
  },
): Promise<void> {
  const path = request.url ?? "";
  const slot = path.includes("modelProvider")
    ? "modelProvider"
    : path.includes("tools")
      ? "tools"
      : path.includes("skills")
        ? "skills"
        : path.includes("knowledge")
          ? "knowledge"
          : "context";
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
    : slot === "knowledge" ? KNOWLEDGE_METHODS
          : ["prepare_for_model", "apply_tool_results", "recover_from_model_error", "capture_turn", "try_auto_compact"];
  const implementationId = `example.${slot}`;
  if (request.method === "GET") {
    writeJson(response, { protocolVersion: "2.0", implementationId, contract, transport: "module-http-v2", methods });
    return;
  }
  const body = await readJson(request);
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const operation = String(payload.operation ?? (slot === "tools" ? "execute" : ""));
  calls.push(`${slot}:${operation}`);
  const knowledgeFault = compaction.knowledgeFault;
  if (knowledgeFault?.enabled() && slot === "knowledge" && operation === "query") {
    knowledgeFault.reached();
    await knowledgeFault.released;
    writeJson(response, {
      kind: "response",
      messageId: `response-${String(body.messageId)}`,
      inReplyTo: body.messageId,
      requestId: body.requestId,
      ok: true,
      code: "KNOWLEDGE_PROTOCOL_CONTRADICTION",
      error: {
        code: "KNOWLEDGE_PROTOCOL_CONTRADICTION",
        message: "rpc-fault-knowledge: contradictory response envelope",
        retryability: "unsafe",
      },
      payload: { result: { hits: [] } },
    });
    return;
  }
  let result: unknown;
  if (slot === "skills" && operation === "list") {
    result = { builtin: [], user: [], project: [], projectPath: projectRoot, items: [{ slug: "approval-guide", name: "Approval Guide", description: "Approval guide", skillFile: "/external/approval-guide/SKILL.md" }] };
  } else if (slot === "skills" && operation === "read") {
    result = { content: "# Approval Guide\nUse evidence.", scope: "project", slug: "approval-guide", skill: null };
  } else if (slot === "knowledge" && operation === "query") {
    result = { hits: [{ id: "chunk-1", text: "Approval requires evidence.", citationId: "citation-1" }] };
  } else if (slot === "knowledge") {
    result = { operation, accepted: true };
  } else if (slot === "modelProvider" && operation === "prepare") {
    result = { prepared: { request: payload.request, provider: "remote", model: "default" } };
  } else if (slot === "modelProvider" && operation === "stream") {
    const modelRequest = (payload.request ?? {}) as Record<string, unknown>;
    compaction.modelRequests?.push(structuredClone(modelRequest));
    const serializedMessages = JSON.stringify(modelRequest.messages ?? []);
    const hasToolResult = serializedMessages.includes("tool_result");
    const hasSubmitResult = serializedMessages.includes("submit-call");
    const hasKnowledgeFault = serializedMessages.includes("Successful module response contains failure fields.");
    const submission = compaction.nextSubmission();
    result = { events: submission
      ? [
          { type: "request_started", provider: "remote", model: "default" },
          { type: "message_start", role: "assistant" },
          ...toolCall("wait-submit", "submit_step_result", submission),
          { type: "message_end", finishReason: "tool_call" },
        ]
      : hasSubmitResult
      ? [
          { type: "request_started", provider: "remote", model: "default" },
          { type: "message_start", role: "assistant" },
          { type: "text_delta", text: "External sidecar SOP completed." },
          { type: "message_end", finishReason: "stop" },
        ]
      : hasKnowledgeFault
        ? [
            { type: "request_started", provider: "remote", model: "default" },
            { type: "message_start", role: "assistant" },
            { type: "text_delta", text: "Knowledge RPC fault observed without advancing SOP." },
            { type: "message_end", finishReason: "stop" },
          ]
      : hasToolResult
        ? [
          { type: "request_started", provider: "remote", model: "default" },
          { type: "message_start", role: "assistant" },
          ...toolCall("submit-call", "submit_step_result", { status: "completed", replyFragment: "External sidecar SOP completed." }),
          { type: "message_end", finishReason: "tool_call" },
        ]
        : [
          { type: "request_started", provider: "remote", model: "default" },
          { type: "message_start", role: "assistant" },
          ...toolCall("skill-call", "read_skill", { skillName: "approval-guide" }),
          ...toolCall("lookup-call", "remote_lookup", { key: "approval" }),
          ...toolCall("knowledge-call", "knowledge_query", { query: "approval evidence" }),
          { type: "message_end", finishReason: "tool_call" },
        ] };
  } else if (slot === "tools") {
    result = { type: "success", toolCallId: payload.toolCallId, toolName: payload.name, content: [{ type: "text", text: "remote lookup result" }] };
  } else if (operation === "apply_tool_results") {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const toolResultMessage = input.toolResultMessage;
    result = {
      messages: toolResultMessage === undefined ? messages : [...messages, toolResultMessage],
      ...(toolResultMessage === undefined ? {} : { appendedMessages: [toolResultMessage] }),
      diagnostics: [],
    };
  } else if (operation === "recover_from_model_error") {
    result = { type: "give_up", reason: "external_context_recovery_not_needed" };
  } else if (operation === "capture_turn") {
    result = {};
  } else if (operation === "try_auto_compact") {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const trigger = input.trigger === "manual" ? "manual" : "auto";
    const shouldCompact = trigger === "manual"
      ? compaction.consumeManualCompaction()
      : compaction.consumeAutomaticCompaction();
    const maxContextTokens = Number(input.maxContextTokens ?? 65536);
    const snapshot = {
      tokens: shouldCompact ? 24 : 0,
      maxContextTokens,
      warningRatio: 0.8,
      blockingRatio: 0.95,
      state: "ok" as const,
      ratio: shouldCompact ? 0.1 : 0,
    };
    if (!shouldCompact) {
      result = { type: "skipped", snapshot };
    } else {
      const summaryText = trigger === "manual"
        ? "External manual compaction summary"
        : "External automatic compaction summary";
      const summary = { role: "assistant", content: [{ type: "text", text: summaryText }] };
      result = {
        type: "compacted",
        messages: [summary],
        tier: "full",
        snapshot,
        result: {
          compactionId: `external-${trigger}-compact-1`,
          trigger,
          preTokens: 128,
          postTokens: 24,
          messagesSummarized: 1,
          summaryMessage: summary,
          boundaryMarker: summary,
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          diagnostics: [],
          summaryGenerated: true,
        },
      };
    }
  } else {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    result = { messages: input.messages ?? [], systemPromptParts: [], tools: input.tools ?? [], diagnostics: [], boundaries: [] };
  }
  writeJson(response, {
    kind: "response",
    messageId: `response-${String(body.messageId)}`,
    inReplyTo: body.messageId,
    requestId: body.requestId,
    ok: true,
    payload: ["context", "skills", "knowledge"].includes(slot) ? { result } : result,
  });
}

async function routeSop(
  request: IncomingMessage,
  response: ServerResponse,
  calls: string[],
  options: { isHandoffSession(sessionId: string): boolean },
): Promise<void> {
  if (request.method === "GET") {
    writeJson(response, {
      status: "ok",
      protocolVersion: "2.0",
      moduleId: "sop.runtime",
      contract: "sop.lifecycle/v2",
      descriptorVersion: "1.0",
      implementationId: "example.sop",
      transport: "sop-http-v2",
      operations: ["prepare", "submit"],
    });
    return;
  }
  const body = await readJson(request);
  const operation = String((body.payload as Record<string, unknown> | undefined)?.proposal ? "submit" : "prepare");
  calls.push(operation);
  const payload = body.payload as Record<string, unknown>;
  const sessionId = String(body.sessionId ?? "");
  const handoffSession = options.isHandoffSession(sessionId);
  if (operation === "prepare") {
    writeJson(response, {
      protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed",
      payload: {
        state: { ...(payload.state as Record<string, unknown>), status: "active", active_skill_id: "approval", active_step_id: "only" },
        step: {
          skillId: "approval", skillName: "Approval", version: "1", nodeId: "only", node: {},
          instruction: handoffSession ? "Wait for external approval." : "Read the approval guide and knowledge record.",
          expectedUserInfo: [], knownSlots: {},
          allowedNextStepIds: [], requiredToolNames: handoffSession ? [] : ["remote_lookup", "knowledge_query"],
          allowedActions: handoffSession ? [] : ["call_tool:remote_lookup", "call_tool:knowledge_query"],
          isTerminal: true, declaresHandoff: handoffSession,
        },
      },
    });
    return;
  }
  const proposal = (payload.proposal ?? {}) as Record<string, unknown>;
  const status = String(proposal.status ?? "");
  if (handoffSession && status === "handoff") {
    writeJson(response, {
      protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed",
      payload: {
        state: { ...(payload.state as Record<string, unknown>), status: "handoff", successful_tool_names: [] },
        result: { status: "handoff", replyFragment: "External sidecar waiting for approval.", slotUpdates: {}, events: [] },
      },
    });
    return;
  }
  writeJson(response, {
    protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed",
    payload: {
      state: { ...(payload.state as Record<string, unknown>), status: "completed", successful_tool_names: [] },
      result: { status: "completed", replyFragment: "External sidecar SOP completed.", slotUpdates: {}, events: [] },
    },
  });
}

function toolCall(id: string, name: string, input: unknown): Array<Record<string, unknown>> {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_end", toolCall: { id, name, input } },
  ];
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
