import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
} from "../../src/agent/index.js";
import { createSidecarExecution } from "../../src/cli/pilotdeck-agent-loop-default-factory.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createKnowledgeModulePort } from "../../src/composition/domainPorts.js";
import type { CompactionAutomaticTriggerObservation } from "../../src/context/index.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest, type ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { loadPilotConfig } from "../../src/pilot/config/loadPilotConfig.js";
import { createAgentProjectSessionStorage, readTranscript } from "../../src/session/index.js";

const STAFFDECK_ROOT = process.env.STAFFDECK_SOP_ROOT ?? "/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop";
const PYTHON = process.env.STAFFDECK_PYTHON ?? join(STAFFDECK_ROOT, "backend/.venv/bin/python");
const REAL_MODEL_SOURCE_PILOT_HOME = process.env.REAL_SEVEN_SLOT_MODEL_SOURCE_PILOT_HOME ?? "/Users/a1/.pilotdeck";
const B0_NATIVE_TOOL_SURFACE = [
  "agent",
  "ask_user_question",
  "bash",
  "edit_file",
  "edit_notebook",
  "execute_code",
  "get_current_time",
  "glob",
  "grep",
  "knowledge_query",
  "mcp__funasr__transcribe_audio",
  "read_file",
  "read_skill",
  "send_attachment",
  "structured_output",
  "submit_step_result",
  "task_create",
  "task_list",
  "task_output",
  "task_stop",
  "task_wait",
  "todo_write",
  "web_fetch",
  "write_file",
] as const;

/**
 * This is the real-owner composition case.  Only the deterministic model and
 * the other PilotDeck module fixtures are local HTTP fixtures; Knowledge and
 * SOP are separate StaffDeck processes using their native owners.
 */
test("seven-slot YAML composition uses real StaffDeck Knowledge and SOP processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-real-staffdeck-seven-slot-"));
  const projectRoot = join(root, "project");
  const database = join(root, "knowledge.sqlite");
  const moduleCalls: string[] = [];
  const knowledgeQueries: Record<string, unknown>[] = [];
  let phase: "initial" | "waiting" | "resumed" = "initial";
  let automaticCompaction = true;
  let manualCompaction = true;
  const realModel = process.env.PILOTDECK_REAL_SEVEN_SLOT_MODEL === "1"
    ? createRealModelFixture(REAL_MODEL_SOURCE_PILOT_HOME)
    : undefined;
  const moduleOptions = {
    calls: moduleCalls,
    knowledgeQueries,
    projectRoot,
    baseId: "__BASE_ID__",
    phase: () => phase,
    consumeAutomaticCompaction: () => {
      const value = automaticCompaction;
      automaticCompaction = false;
      return value;
    },
    consumeManualCompaction: () => {
      const value = manualCompaction;
      manualCompaction = false;
      return value;
    },
    realModel,
  };

  const knowledge = await startPythonService({
    root: STAFFDECK_ROOT,
    python: PYTHON,
    module: "app.module_knowledge_app:app",
    cwd: join(STAFFDECK_ROOT, "backend"),
    healthPath: "/api/health",
    env: {
      DATABASE_URL: `sqlite:///${database}`,
      DEMO_SEED_ENABLED: "false",
      STAFFDECK_KNOWLEDGE_SEED: "true",
      STARTUP_ORPHAN_CLEANUP_ENABLED: "false",
      PUBLIC_API_ENABLED: "false",
      HARNESS_V3_ENABLED: "false",
      HARNESS_ADMIN_API_ENABLED: "false",
      STAFFDECK_KNOWLEDGE_USER_ID: "admin",
      STAFFDECK_KNOWLEDGE_TENANT_ID: "tenant_demo",
    },
  });
  const sop = await startPythonService({
    root: STAFFDECK_ROOT,
    python: PYTHON,
    module: "staffdeck_sop_runtime.api:app",
    cwd: STAFFDECK_ROOT,
    healthPath: "/healthz",
  });
  const knowledgeProxyState: KnowledgeProxyState = { dropNextImportResponse: false, importDispatchCount: 0 };
  const knowledgeProxy = await startKnowledgeProxy(knowledge.url, knowledgeQueries, knowledgeProxyState);

  const moduleServer = createServer(async (request, response) => {
    await routePilotDeckModule(request, response, moduleOptions);
  });
  await listen(moduleServer);
  const moduleEndpoint = serverUrl(moduleServer);

  let sidecar = await startSidecar();
  const restartSidecar = async () => {
    const address = sidecar.address;
    await sidecar.server.close();
    sidecar = await startSidecar(address.host, address.port);
  };

  t.after(async () => {
    await sidecar.server.close();
    await closeServer(moduleServer);
    await knowledgeProxy.close();
    await knowledge.close();
    await sop.close();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval.yaml"), `
sops:
  - id: approval
    version: "1"
    name: Knowledge approval
    content:
      start_node_id: approval
      nodes:
        - node_id: approval
          type: handoff
          instruction: Check the approval policy and wait for an operator decision.
          allowed_actions:
            - call_tool:remote_lookup
            - call_tool:knowledge_query
      terminal_node_ids: [approval]
`, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), sevenSlotConfig({
    moduleEndpoint,
    knowledgeEndpoint: knowledgeProxy.url,
    sopEndpoint: sop.url,
    sidecarHost: sidecar.address.host,
    sidecarPort: sidecar.address.port,
    definitionsPath: join(projectRoot, "approval.yaml"),
  }), "utf8");

  const knowledgePort = createKnowledgeModulePort({
    enabled: true,
    implementationId: "staffdeck.knowledge",
    contract: "staffdeck.knowledge/v1",
    transport: "module-http-v2",
    endpoint: knowledgeProxy.url,
    manifestPath: "/module-manifest",
    callPath: "/v2/module/call",
    methods: [
      "list_bases", "create_base", "get_base", "update_base", "delete_base", "list_versions",
      "sync_base", "publish_version", "rollback_version", "list_documents", "get_document",
      "import_document", "import_okf", "update_document", "delete_document", "list_document_buckets",
      "update_bucket", "list_bucket_chunks", "update_chunk", "get_job", "list_jobs", "cancel_job",
      "list_okf_concepts", "get_okf_concept", "upsert_okf_concept", "export_okf", "lint_okf",
      "list_discoveries", "confirm_discovery", "reject_discovery", "query", "resolve_citation",
    ],
  });
  const created = await knowledgePort.call("create_base", {
    tenantId: "tenant_demo",
    actorUserId: "admin",
    name: "Real seven-slot approval policy",
    description: "PilotDeck composition fixture",
  });
  const baseId = textField(created, "id");
  const imported = await knowledgePort.call("import_document", {
    tenantId: "tenant_demo",
    actorUserId: "admin",
    knowledgeBaseId: baseId,
    filename: "approval-policy.md",
    title: "Approval policy",
    contentBase64: Buffer.from("# Approval policy\n\nAll production changes require owner approval before release.\n").toString("base64"),
  });
  const jobId = textField(imported, "id");
  await pollKnowledgeJob(knowledgePort, jobId);

  // The fixture model needs the real base id in its tool input.  Update the
  // closure after the owner has created the durable resource.
  moduleOptions.baseId = baseId;
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    const events: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "real-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Review the approval policy and request operator approval.",
      mode: "bypassPermissions",
    })) events.push(event);
    phase = "waiting";
    const waiting = await local.gateway.sopStatus!({ sessionKey: "real-seven-slot", projectKey: projectRoot });
    assert.equal(waiting?.state.status, "handoff", JSON.stringify({ events, waiting }));
    await assert.rejects(
      () => local.gateway.resumeSop!({
        sessionKey: "real-seven-slot-other-session",
        projectKey: projectRoot,
        requestId: "stale-cross-session-resume",
        waitId: waiting!.wait!.id,
        source: "human",
        message: "Stale approval must not cross session boundaries.",
      }),
    );
    assert.ok(moduleCalls.includes("skills:list"), JSON.stringify(moduleCalls));
    assert.ok(moduleCalls.includes("skills:read"), JSON.stringify(moduleCalls));
    assert.ok(moduleCalls.includes("tools:execute"), JSON.stringify(moduleCalls));
    assert.ok(moduleCalls.includes("context:prepare_for_model"), JSON.stringify(moduleCalls));
    assert.ok(moduleCalls.includes("context:try_auto_compact"), JSON.stringify(moduleCalls));
    assert.ok(moduleCalls.includes("modelProvider:stream"), JSON.stringify(moduleCalls));
    assert.equal(knowledgeQueries.length, 1, JSON.stringify({ knowledgeQueries, events }));
    assert.deepEqual(knowledgeQueries[0]?.knowledgeBaseIds, [baseId]);
    assert.equal(knowledgeQueries[0]?.tenantId, "tenant_demo");
    assert.equal(knowledgeQueries[0]?.actorUserId, "admin");

    const query = await knowledgePort.call("query", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "owner approval before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    });
    const citationId = evidenceCitationId(query);
    const citation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId });
    assert.equal(textField(citation, "id"), citationId);
    assert.match(textField(citation, "content").toLowerCase(), /owner approval/);

    await knowledge.close();
    await assert.rejects(
      () => knowledgePort.call("query", {
        tenantId: "tenant_demo",
        actorUserId: "admin",
        knowledgeBaseIds: [baseId],
        query: "owner approval before release",
        queryType: "answer",
        maxChunks: 8,
        maxBuckets: 4,
        budgetTokens: 4000,
        needEvidencePack: true,
      }),
    );
    const waitDuringKnowledgeOutage = await local.gateway.sopStatus!({ sessionKey: "real-seven-slot", projectKey: projectRoot });
    assert.equal(waitDuringKnowledgeOutage?.state.status, "handoff");
    await knowledge.restart();
    const recoveredQuery = await knowledgePort.call("query", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "owner approval before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    });
    assert.equal(evidenceCitationId(recoveredQuery), citationId, JSON.stringify(recoveredQuery));
    const recoveredCitation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId });
    assert.equal(textField(recoveredCitation, "id"), citationId);

    await restartSidecar();
    const resumed = await local.gateway.resumeSop!({
      sessionKey: "real-seven-slot",
      projectKey: projectRoot,
      requestId: "real-seven-slot-resume-1",
      waitId: waiting!.wait!.id,
      source: "human",
      message: "Operator approved the policy.",
      expectedRevision: waiting!.revision,
      slotUpdates: { approved: true },
    });
    assert.equal(resumed.duplicate, false, JSON.stringify(resumed));
    const duplicate = await local.gateway.resumeSop!({
      sessionKey: "real-seven-slot",
      projectKey: projectRoot,
      requestId: "real-seven-slot-resume-1",
      waitId: waiting!.wait!.id,
      source: "human",
      message: "Operator approved the policy.",
    });
    assert.equal(duplicate.duplicate, true, JSON.stringify(duplicate));
    phase = "resumed";
    const completedEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "real-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: resumed.message,
      mode: "bypassPermissions",
    })) completedEvents.push(event);
    const completed = await local.gateway.sopStatus!({ sessionKey: "real-seven-slot", projectKey: projectRoot });
    assert.equal(completed?.state.status, "completed", JSON.stringify({ completedEvents, completed }));
    assert.ok(moduleCalls.includes("context:apply_tool_results"), JSON.stringify(moduleCalls));
    const manual: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "real-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "/compact",
      mode: "bypassPermissions",
    })) manual.push(event);
    assert.match(JSON.stringify(manual), /Compacted/);

    knowledgeProxyState.dropNextImportResponse = true;
    await assert.rejects(
      () => knowledgePort.call("import_document", {
        tenantId: "tenant_demo",
        actorUserId: "admin",
        knowledgeBaseId: baseId,
        filename: "lost-response.md",
        title: "Lost response fixture",
        contentBase64: Buffer.from("# Lost response fixture\n\nThis write must be recovered from its job status.\n").toString("base64"),
      }),
    );
    const lostResponseJobId = knowledgeProxyState.lastDroppedImportJobId;
    assert.ok(lostResponseJobId, JSON.stringify(knowledgeProxyState));
    await pollKnowledgeJob(knowledgePort, lostResponseJobId);
    const afterLostResponseDocuments = await knowledgePort.call("list_documents", { tenantId: "tenant_demo", knowledgeBaseId: baseId });
    assert.ok(Array.isArray(afterLostResponseDocuments) && afterLostResponseDocuments.some((item) => textField(item, "filename") === "lost-response.md"));

    const documents = await knowledgePort.call("list_documents", {
      tenantId: "tenant_demo",
      knowledgeBaseId: baseId,
    });
    const sourceDocument = Array.isArray(documents)
      ? documents.find((item) => textField(item, "filename") === "approval-policy.md")
      : undefined;
    const documentId = textField(sourceDocument, "id");
    await knowledgePort.call("update_document", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      documentId,
      title: "Updated approval policy",
      contentMd: "# Updated approval policy\n\nSecurity review is required before release.",
    });
    await assert.rejects(
      () => knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId }),
      (error: unknown) => (error as { code?: string }).code === "STAFFDECK_HTTP_404",
    );
    const updatedQuery = await knowledgePort.call("query", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "security review required before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    });
    const updatedCitationId = evidenceCitationId(updatedQuery);
    assert.notEqual(updatedCitationId, citationId);
    const updatedCitation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: updatedCitationId });
    assert.match(textField(updatedCitation, "content").toLowerCase(), /security review/);
    const archived = await knowledgePort.call("delete_document", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      documentId,
    });
    assert.equal(textField(archived, "status"), "archived");
    const deletedQuery = await knowledgePort.call("query", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "security review required before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    });
    assert.ok(Array.isArray((deletedQuery as { evidence_pack?: unknown }).evidence_pack));
  } finally {
    await local.dispose();
  }
});

test("native PilotDeck owners compose real StaffDeck Knowledge and SOP through Gateway", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-native-owner-seven-slot-"));
  const projectRoot = join(root, "project");
  const database = join(root, "knowledge.sqlite");
  const knowledgeQueries: Record<string, unknown>[] = [];
  const automaticCompactionTriggers: CompactionAutomaticTriggerObservation[] = [];
  const model = new NativeOwnerScenarioModel();
  const knowledge = await startPythonService({
    root: STAFFDECK_ROOT,
    python: PYTHON,
    module: "app.module_knowledge_app:app",
    cwd: join(STAFFDECK_ROOT, "backend"),
    healthPath: "/api/health",
    env: {
      DATABASE_URL: `sqlite:///${database}`,
      DEMO_SEED_ENABLED: "false",
      STAFFDECK_KNOWLEDGE_SEED: "true",
      STARTUP_ORPHAN_CLEANUP_ENABLED: "false",
      PUBLIC_API_ENABLED: "false",
      HARNESS_V3_ENABLED: "false",
      HARNESS_ADMIN_API_ENABLED: "false",
      STAFFDECK_KNOWLEDGE_USER_ID: "admin",
      STAFFDECK_KNOWLEDGE_TENANT_ID: "tenant_demo",
    },
  });
  const sop = await startPythonService({
    root: STAFFDECK_ROOT,
    python: PYTHON,
    module: "staffdeck_sop_runtime.api:app",
    cwd: STAFFDECK_ROOT,
    healthPath: "/healthz",
  });
  const knowledgeProxyState: KnowledgeProxyState = { dropNextImportResponse: false, importDispatchCount: 0 };
  const knowledgeProxy = await startKnowledgeProxy(knowledge.url, knowledgeQueries, knowledgeProxyState);
  t.after(async () => {
    await knowledgeProxy.close();
    await knowledge.close();
    await sop.close();
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(projectRoot, ".pilotdeck", "skills", "approval-guide"), { recursive: true });
  await writeFile(join(projectRoot, ".pilotdeck", "skills", "approval-guide", "SKILL.md"), [
    "---",
    "name: approval-guide",
    "description: Approval evidence guide",
    "---",
    "",
    "# Approval Guide",
    "Always cite the approval policy.",
  ].join("\n"), "utf8");
  await writeFile(join(projectRoot, "approval-input.txt"), "Owner approval is required before release.\n", "utf8");
  const approvalDefinition = {
    id: "approval",
    version: "1",
    name: "Native owner approval",
    content: {
      start_node_id: "approval",
      nodes: [{
        node_id: "approval",
        type: "handoff",
        instruction: "Read the approval file and policy before requesting approval.",
        allowed_actions: ["call_tool:read_file", "call_tool:knowledge_query"],
      }],
      terminal_node_ids: ["approval"],
    },
  };
  const approvalPolicyContent = "# Approval policy\n\nOwner approval is required before release.\n";
  await writeFile(join(projectRoot, "approval.yaml"), `
sops:
  - id: approval
    version: "1"
    name: Native owner approval
    content:
      start_node_id: approval
      nodes:
        - node_id: approval
          type: handoff
          instruction: Read the approval file and policy before requesting approval.
          allowed_actions:
            - call_tool:read_file
            - call_tool:knowledge_query
      terminal_node_ids: [approval]
`, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), nativeOwnerConfig({
    knowledgeEndpoint: knowledgeProxy.url,
    sopEndpoint: sop.url,
    definitionsPath: join(projectRoot, "approval.yaml"),
  }), "utf8");

  const knowledgePort = createKnowledgeModulePort({
    enabled: true,
    implementationId: "staffdeck.knowledge",
    contract: "staffdeck.knowledge/v1",
    transport: "module-http-v2",
    endpoint: knowledgeProxy.url,
    manifestPath: "/module-manifest",
    callPath: "/v2/module/call",
    methods: ["create_base", "import_document", "get_job", "list_documents", "update_document", "delete_document", "query", "resolve_citation"],
  });
  const created = await knowledgePort.call("create_base", {
    tenantId: "tenant_demo",
    actorUserId: "admin",
    name: "Native owner approval policy",
  });
  const baseId = textField(created, "id");
  const imported = await knowledgePort.call("import_document", {
    tenantId: "tenant_demo",
    actorUserId: "admin",
    knowledgeBaseId: baseId,
    filename: "approval-policy.md",
    title: "Approval policy",
    contentBase64: Buffer.from(approvalPolicyContent).toString("base64"),
  });
  await pollKnowledgeJob(knowledgePort, textField(imported, "id"));
  model.baseId = baseId;

  const createNativeOwnerGateway = (runtimeModel = model) => createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => runtimeModel,
    __testOnAutomaticCompactionTrigger: (observation) => {
      automaticCompactionTriggers.push(observation);
    },
  });
  let local = createNativeOwnerGateway();
  try {
    const firstEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Read the approval file and request operator approval.",
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) firstEvents.push(event);
    const waiting = await local.gateway.sopStatus!({ sessionKey: "native-owner-seven-slot", projectKey: projectRoot });
    assert.equal(waiting?.state.status, "handoff", JSON.stringify({ firstEvents, waiting }));
    assert.equal(knowledgeQueries.length, 1, JSON.stringify({ knowledgeQueries, firstEvents }));
    assert.deepEqual(knowledgeQueries[0]?.knowledgeBaseIds, [baseId]);
    assert.equal(knowledgeQueries[0]?.tenantId, "tenant_demo");
    assert.equal(knowledgeQueries[0]?.actorUserId, "admin");
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "read_skill"), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "read_file"), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "knowledge_query"), true);
    assert.match(JSON.stringify(model.requests), /Always cite the approval policy/);
    assert.match(JSON.stringify(model.requests), /Owner approval is required before release/);

    const query = await knowledgePort.call("query", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "owner approval before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    });
    const citationId = evidenceCitationId(query);
    const citation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId });
    assert.match(textField(citation, "content").toLowerCase(), /owner approval/);
    const initialDocuments = await knowledgePort.call("list_documents", {
      tenantId: "tenant_demo",
      knowledgeBaseId: baseId,
    });
    const sourceDocumentId = textField(
      Array.isArray(initialDocuments)
        ? initialDocuments.find((item) => textField(item, "filename") === "approval-policy.md")
        : undefined,
      "id",
    );

    const firstSessionBeforeStaleResume = projectSopState(waiting);
    const secondSessionEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-seven-slot-second",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Review the approval policy independently.",
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) secondSessionEvents.push(event);
    const secondSessionWaiting = await local.gateway.sopStatus!({
      sessionKey: "native-owner-seven-slot-second",
      projectKey: projectRoot,
    });
    assert.equal(secondSessionWaiting?.state.status, "handoff", JSON.stringify(secondSessionEvents));
    await assert.rejects(
      () => local.gateway.resumeSop!({
        sessionKey: "native-owner-seven-slot-second",
        projectKey: projectRoot,
        requestId: "native-owner-cross-session-stale-resume",
        waitId: waiting!.wait!.id,
        source: "human",
        message: "This stale resume must not affect the first session.",
      }),
    );
    const firstSessionAfterStaleResume = await local.gateway.sopStatus!({
      sessionKey: "native-owner-seven-slot",
      projectKey: projectRoot,
    });
    assert.deepEqual(projectSopState(firstSessionAfterStaleResume), firstSessionBeforeStaleResume);

    const sopBeforeKnowledgeOutage = projectSopState(waiting);
    await knowledge.close();
    await assert.rejects(
      () => knowledgePort.call("query", {
        tenantId: "tenant_demo",
        actorUserId: "admin",
        knowledgeBaseIds: [baseId],
        query: "owner approval before release",
        queryType: "answer",
        maxChunks: 8,
        maxBuckets: 4,
        budgetTokens: 4000,
        needEvidencePack: true,
      }),
    );
    const sopDuringKnowledgeOutage = await local.gateway.sopStatus!({ sessionKey: "native-owner-seven-slot", projectKey: projectRoot });
    assert.deepEqual(projectSopState(sopDuringKnowledgeOutage), sopBeforeKnowledgeOutage);
    await knowledge.restart();
    const recoveredCitation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId });
    assert.equal(textField(recoveredCitation, "content"), textField(citation, "content"));

    const documentId = sourceDocumentId;
    const updatedPolicyContent = "# Updated approval policy\n\nSecurity review is required before release.\n";
    await knowledgePort.call("update_document", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      documentId,
      title: "Updated approval policy",
      contentMd: updatedPolicyContent,
    });
    await assert.rejects(
      () => knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: citationId }),
      (error: unknown) => (error as { code?: string }).code === "STAFFDECK_HTTP_404",
    );
    const updatedQueryRequest = {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      knowledgeBaseIds: [baseId],
      query: "security review required before release",
      queryType: "answer",
      maxChunks: 8,
      maxBuckets: 4,
      budgetTokens: 4000,
      needEvidencePack: true,
    };
    const updatedQuery = await knowledgePort.call("query", updatedQueryRequest);
    const updatedCitationId = evidenceCitationId(updatedQuery);
    assert.notEqual(updatedCitationId, citationId);
    const updatedCitation = await knowledgePort.call("resolve_citation", { tenantId: "tenant_demo", chunkId: updatedCitationId });
    assert.match(textField(updatedCitation, "content").toLowerCase(), /security review/);
    const archived = await knowledgePort.call("delete_document", {
      tenantId: "tenant_demo",
      actorUserId: "admin",
      documentId,
    });
    assert.equal(textField(archived, "status"), "archived");
    const archivedQuery = await knowledgePort.call("query", updatedQueryRequest);
    const archivedEvidence = (archivedQuery as { evidence_pack?: unknown }).evidence_pack;
    assert.equal(Array.isArray(archivedEvidence), true, JSON.stringify(archivedQuery));
    assert.equal((archivedEvidence as unknown[]).length, 0, JSON.stringify(archivedQuery));

    const importDispatchCountBeforeLostResponse = knowledgeProxyState.importDispatchCount;
    knowledgeProxyState.dropNextImportResponse = true;
    await assert.rejects(
      () => knowledgePort.call("import_document", {
        tenantId: "tenant_demo",
        actorUserId: "admin",
        knowledgeBaseId: baseId,
        filename: "lost-native-response.md",
        title: "Lost native response",
        contentBase64: Buffer.from("# Lost native response\n\nThe import job must be recovered without retry.\n").toString("base64"),
      }),
    );
    const lostResponseJobId = knowledgeProxyState.lastDroppedImportJobId;
    assert.ok(lostResponseJobId, JSON.stringify(knowledgeProxyState));
    assert.equal(knowledgeProxyState.importDispatchCount, importDispatchCountBeforeLostResponse + 1);
    await pollKnowledgeJob(knowledgePort, lostResponseJobId);
    const documentsAfterLostResponse = await knowledgePort.call("list_documents", {
      tenantId: "tenant_demo",
      knowledgeBaseId: baseId,
    });
    const recoveredLostDocuments = Array.isArray(documentsAfterLostResponse)
      ? documentsAfterLostResponse.filter((item) => textField(item, "filename") === "lost-native-response.md")
      : [];
    assert.equal(recoveredLostDocuments.length, 1, JSON.stringify(documentsAfterLostResponse));

    const resumed = await local.gateway.resumeSop!({
      sessionKey: "native-owner-seven-slot",
      projectKey: projectRoot,
      requestId: "native-owner-seven-slot-resume",
      waitId: waiting!.wait!.id,
      source: "human",
      message: "Operator approved the policy.",
      expectedRevision: waiting!.revision,
      slotUpdates: { approved: true },
    });
    model.phase = "resumed";
    const completedEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: resumed.message,
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) completedEvents.push(event);
    const completed = await local.gateway.sopStatus!({ sessionKey: "native-owner-seven-slot", projectKey: projectRoot });
    assert.equal(completed?.state.status, "completed", JSON.stringify({ completedEvents, completed }));
    model.phase = "completed";
    const automaticCompaction: unknown[] = [];
    const automaticTurns: string[] = [];
    const automaticModelRequestsStart = model.requests.length;
    for (let index = 0; index < 30; index += 1) {
      const message = `Preserve approval history segment ${index}. ${"approval ".repeat(2_000)}`;
      automaticTurns.push(message);
      for await (const event of local.gateway.submitTurn({
        sessionKey: "native-owner-seven-slot",
        workspaceCwd: projectRoot,
        channelKey: "test",
        message,
        mode: "bypassPermissions",
      })) automaticCompaction.push(event);
      if (hasCompletedAutomaticCompaction(automaticCompaction)) break;
    }
    assert.equal(hasCompletedAutomaticCompaction(automaticCompaction), true, JSON.stringify(automaticCompaction));
    const automaticStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "native-owner-seven-slot",
    });
    const automaticTranscript = await readTranscript(automaticStorage.transcriptPath);
    const automaticBoundary = [...automaticTranscript.entries].reverse().find((entry) => entry.type === "control_boundary"
      && entry.boundary.kind === "compact"
      && entry.boundary.subtype === "compact_boundary"
      && entry.boundary.compactMetadata.trigger === "auto");
    if (!automaticBoundary || automaticBoundary.type !== "control_boundary") {
      assert.fail("native owner automatic compaction did not persist a compact boundary");
    }
    const compactBoundaries = automaticTranscript.entries.flatMap((entry) => entry.type === "control_boundary"
      && entry.boundary.kind === "compact"
      && entry.boundary.subtype === "compact_boundary"
      ? [entry.boundary]
      : []);
    const automaticSummaryRequests = model.requests
      .slice(automaticModelRequestsStart)
      .filter(isCompactionSummaryRequest);
    const automaticTriggerMatches = automaticCompactionTriggers.filter((trigger) => trigger.fullSummaryStarted);
    assert.ok(automaticSummaryRequests.length > 0, "native owner automatic compaction did not call the summary model");
    assert.equal(automaticSummaryRequests.length, automaticTriggerMatches.length, JSON.stringify({
      summaryRequests: automaticSummaryRequests.map((request) => ({
        messageCount: request.messages.length,
        control: request.messages.at(-1)?.metadata?.purpose,
      })),
      triggers: automaticCompactionTriggers.map((trigger) => ({
        stage: trigger.input.budgetStage,
        fullSummaryStarted: trigger.fullSummaryStarted,
        snapshot: trigger.snapshot,
      })),
    }));
    const savedAutomaticTriggers = automaticTriggerMatches.map(saveAutomaticCompactionTrigger);
    const usedSummaryRequestIndexes = new Set<number>();
    const automaticAttempts = savedAutomaticTriggers.map((trigger, index) => {
      const events = automaticCompaction.filter((event) => event && typeof event === "object"
        && (event as Record<string, unknown>).runId === trigger.input.turnId);
      const autoCompleted = events.find((event) => {
        const detail = (event as Record<string, unknown>).detail;
        return (event as Record<string, unknown>).event === "compact_completed"
          && typeof detail === "object" && detail !== null
          && (detail as Record<string, unknown>).trigger === "auto";
      }) as Record<string, unknown> | undefined;
      const autoDetail = autoCompleted?.detail as Record<string, unknown> | undefined;
      const autoStatus = typeof autoDetail?.status === "string" ? autoDetail.status : "unknown";
      const reactiveCompleted = events.find((event) => {
        const detail = (event as Record<string, unknown>).detail;
        return (event as Record<string, unknown>).event === "compact_completed"
          && typeof detail === "object" && detail !== null
          && (detail as Record<string, unknown>).trigger === "reactive";
      }) as Record<string, unknown> | undefined;
      const reactiveDetail = reactiveCompleted?.detail as Record<string, unknown> | undefined;
      const expectedSummaryMaxOutputTokens = reactiveDetail?.status === "success" ? 1_536 : 4_000;
      const summaryRequestIndex = automaticSummaryRequests.findIndex((request, requestIndex) => !usedSummaryRequestIndexes.has(requestIndex)
        && request.maxOutputTokens === expectedSummaryMaxOutputTokens);
      assert.ok(summaryRequestIndex >= 0, `automatic attempt ${index} has no causally matching summary request`);
      usedSummaryRequestIndexes.add(summaryRequestIndex);
      const compactionIds = events.flatMap((event) => {
        const detail = (event as Record<string, unknown>).detail;
        return typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>).compactionId === "string"
          ? [(detail as Record<string, unknown>).compactionId as string]
          : [];
      });
      const boundary = compactBoundaries.find((candidate) => typeof candidate.compactMetadata.compactionId === "string"
        && compactionIds.includes(candidate.compactMetadata.compactionId));
      return {
        index,
        turnId: trigger.input.turnId,
        trigger,
        summaryRequest: automaticSummaryRequests[summaryRequestIndex],
        boundary,
        outcome: {
          autoStatus,
          reactiveStatus: typeof reactiveDetail?.status === "string" ? reactiveDetail.status : undefined,
          persistedBoundary: boundary !== undefined,
        },
        events,
      };
    });
    const automaticSummaryRequest = automaticSummaryRequests.at(-1);
    assert.ok(automaticSummaryRequest, "native owner automatic compaction did not call the summary model");
    const automaticTriggerObservation = automaticTriggerMatches.at(-1);
    const automaticTrigger = automaticTriggerObservation && saveAutomaticCompactionTrigger(automaticTriggerObservation);
    assert.ok(automaticTrigger, "native owner automatic compaction did not record its trigger input");
    assert.ok(automaticTrigger.budgetEvaluations.length > 1, "native owner automatic compaction did not re-evaluate its compacted candidates");
    for (const [index, evaluation] of automaticTrigger.budgetEvaluations.entries()) {
      assert.ok(evaluation.request, `native owner automatic budget evaluation ${index} has no canonical request`);
      assert.equal(typeof evaluation.maxContextTokens, "number", `native owner automatic budget evaluation ${index} has no context window`);
      assert.equal(typeof evaluation.reservedOutputTokens, "number", `native owner automatic budget evaluation ${index} has no output reserve`);
    }
    const automaticArchive = await local.gateway.exportSessionTranscript!({
      sessionKey: "native-owner-seven-slot",
      projectKey: projectRoot,
    });
    assert.equal(
      automaticArchive.messages.some((message) => message.text.includes('<compact-boundary trigger="auto"')),
      true,
      JSON.stringify(automaticArchive),
    );
    const postAutomaticMessage = "Record the approved policy.";
    const compactBoundaryCountBeforeRestart = automaticTranscript.entries.filter((entry) => entry.type === "control_boundary"
      && entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary").length;
    await local.dispose();
    local = createNativeOwnerGateway();
    const postAutomaticRequestStart = model.requests.length;
    const postAutomaticEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: postAutomaticMessage,
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) postAutomaticEvents.push(event);
    assert.equal(postAutomaticEvents.some((event) => (event as { type?: unknown }).type === "turn_completed"), true);
    const postAutomaticRequests = model.requests.slice(postAutomaticRequestStart);
    assert.equal(postAutomaticRequests.length, 1, JSON.stringify(postAutomaticRequests));
    const postAutomaticRequest = postAutomaticRequests[0];
    assert.ok(postAutomaticRequest, "Gateway restart did not produce a post-compaction model request");
    const automaticTranscriptAfterRestart = await readTranscript(automaticStorage.transcriptPath);
    assert.deepEqual(automaticTranscriptAfterRestart.diagnostics, []);
    const compactBoundaryCountAfterRestart = automaticTranscriptAfterRestart.entries.filter((entry) => entry.type === "control_boundary"
      && entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary").length;
    assert.equal(compactBoundaryCountAfterRestart, compactBoundaryCountBeforeRestart);
    assert.equal(postAutomaticRequest.messages.some((message) => message.content.some((block) => block.type === "text" && block.text === postAutomaticMessage)), true);
    for (const message of ["Record the approval completion."]) {
      for await (const _event of local.gateway.submitTurn({
        sessionKey: "native-owner-seven-slot",
        workspaceCwd: projectRoot,
        channelKey: "test",
        message,
        mode: "bypassPermissions",
        allowedTools: [...B0_NATIVE_TOOL_SURFACE],
      })) {
        // The ordinary turns create native Context history for manual compaction.
      }
    }
    const manualCompaction: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-seven-slot",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "/compact",
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) manualCompaction.push(event);
    assert.match(JSON.stringify(manualCompaction), /Compacted/);

    await local.dispose();
    const disabledSkillModel = new NativeOwnerScenarioModel();
    disabledSkillModel.baseId = baseId;
    await writeFile(join(projectRoot, "pilotdeck.yaml"), nativeOwnerConfig({
      knowledgeEndpoint: knowledgeProxy.url,
      sopEndpoint: sop.url,
      definitionsPath: join(projectRoot, "approval.yaml"),
      skillsEnabled: false,
    }), "utf8");
    local = createNativeOwnerGateway(disabledSkillModel);
    const disabledSkillEvents: unknown[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "native-owner-skills-disabled",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Read the approval file and request operator approval without a Skill module.",
      mode: "bypassPermissions",
      allowedTools: [...B0_NATIVE_TOOL_SURFACE],
    })) disabledSkillEvents.push(event);
    const disabledSkillWaiting = await local.gateway.sopStatus!({
      sessionKey: "native-owner-skills-disabled",
      projectKey: projectRoot,
    });
    assert.equal(disabledSkillWaiting?.state.status, "handoff", JSON.stringify({ disabledSkillEvents, disabledSkillWaiting }));
    const disabledSkillRequest = disabledSkillModel.requests[0];
    assert.ok(disabledSkillRequest, "disabled Skill profile did not reach the native model");
    assert.equal((disabledSkillRequest.tools ?? []).some((tool) => tool.name === "read_skill"), false);
    assert.equal((disabledSkillRequest.tools ?? []).some((tool) => tool.name === "read_file"), true);
    assert.equal((disabledSkillRequest.tools ?? []).some((tool) => tool.name === "knowledge_query"), true);
    assert.doesNotMatch(JSON.stringify(disabledSkillModel.requests), /approval-guide|Approval Guide|Always cite the approval policy/);
    await writeE2EArtifact("e2e01-native-owner-trace.json", {
      schemaVersion: 3,
      scenario: "E2E-01-native-owner",
      modelRequests: model.requests,
      knowledge: {
        createBase: { name: "Native owner approval policy" },
        importDocument: {
          filename: "approval-policy.md",
          title: "Approval policy",
          content: approvalPolicyContent,
        },
        queryRequests: knowledgeQueries,
        citation: { content: textField(citation, "content") },
        outageRecovery: {
          sopBefore: sopBeforeKnowledgeOutage,
          sopDuring: projectSopState(sopDuringKnowledgeOutage),
          recoveredCitation: { content: textField(recoveredCitation, "content") },
        },
        lostResponseRecovery: {
          filename: "lost-native-response.md",
          title: "Lost native response",
          documentCount: recoveredLostDocuments.length,
          dispatchCount: knowledgeProxyState.importDispatchCount - importDispatchCountBeforeLostResponse,
        },
        sessionIsolation: {
          firstBeforeStaleResume: firstSessionBeforeStaleResume,
          firstAfterStaleResume: projectSopState(firstSessionAfterStaleResume),
          second: projectSopState(secondSessionWaiting),
        },
        documentLifecycle: {
          update: { title: "Updated approval policy", content: updatedPolicyContent },
          previousCitationRejected: true,
          updatedQuery: updatedQueryRequest,
          updatedCitation: { content: textField(updatedCitation, "content") },
          archive: { status: textField(archived, "status"), evidenceCount: (archivedEvidence as unknown[]).length },
        },
      },
      sop: {
        definition: approvalDefinition,
        waiting: projectSopState(waiting),
        completed: projectSopState(completed),
      },
      events: {
        firstTurn: firstEvents,
        completedTurn: completedEvents,
        automaticCompaction,
        manualCompaction,
      },
      compaction: {
        automatic: {
          config: { maxContextTokens: 65_536, maxOutputTokens: 8_192 },
          replayWorkspacePath: root,
          turns: automaticTurns,
          trigger: automaticTrigger,
          summaryRequest: automaticSummaryRequest,
          triggers: savedAutomaticTriggers,
          summaryRequests: automaticSummaryRequests,
          boundaries: compactBoundaries,
          attempts: automaticAttempts,
          boundary: automaticBoundary.boundary,
          restart: {
            transcriptEntries: automaticTranscript.entries,
            compactBoundaryCountBeforeRestart,
            compactBoundaryCountAfterRestart,
            postMessage: postAutomaticMessage,
            postRequest: postAutomaticRequest,
          },
          triggeringModelRequests: model.requests.slice(automaticModelRequestsStart),
          nextModelRequest: model.requests.find((request, index) => index >= automaticModelRequestsStart
            && request.messages.some((message) => message.content.some((block) => block.type === "text"
              && block.text === postAutomaticMessage))),
        },
      },
      sideEffects: {
        readFile: { path: "approval-input.txt", content: "Owner approval is required before release.\n" },
        projectSkill: { name: "approval-guide", content: "# Approval Guide\nAlways cite the approval policy." },
      },
      skills: {
        enabled: { modelRequests: model.requests.slice(0, 2), readSkillDispatched: true },
        disabled: {
          modelRequests: disabledSkillModel.requests,
          handoff: projectSopState(disabledSkillWaiting),
          readSkillDispatched: false,
        },
      },
    }, root);
  } finally {
    await local.dispose();
  }
});

type ServiceOptions = {
  root: string;
  python: string;
  module: string;
  cwd: string;
  healthPath: string;
  env?: Record<string, string>;
};

type KnowledgeProxyState = {
  dropNextImportResponse: boolean;
  importDispatchCount: number;
  lastDroppedImportJobId?: string;
};

async function startPythonService(options: ServiceOptions): Promise<{ url: string; restart(): Promise<void>; close(): Promise<void> }> {
  const port = await freePort();
  let child!: ChildProcess;
  let stderr!: string[];
  const spawnChild = (): void => {
    stderr = [];
    child = spawn(options.python, ["-m", "uvicorn", options.module, "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PYTHONPATH: [join(options.root, "backend"), join(options.root, "backend/src"), join(options.root, "portable_sop/src")].join(":"),
        PYTHONUNBUFFERED: "1",
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  };
  const stopChild = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10_000)]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forcedExit = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([forcedExit, delay(10_000)]);
  };
  spawnChild();
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url + options.healthPath, child, stderr);
  return {
    url,
    async restart() {
      await stopChild();
      spawnChild();
      await waitForHealth(url + options.healthPath, child, stderr);
    },
    close: stopChild,
  };
}

async function waitForHealth(url: string, child: ChildProcess, stderr: string[]): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`StaffDeck process exited ${child.exitCode ?? child.signalCode}: ${stderr.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await delay(100);
  }
  throw new Error(`StaffDeck process did not become healthy (${last}): ${stderr.join("")}`);
}

async function startSidecar(host = "127.0.0.1", port = 0) {
  const server = new AgentLoopSidecarTcpServer(new AgentLoopSidecarServer(async (input) => createSidecarExecution(input), { moduleId: "pilotdeck-agent-loop" }));
  const address = await server.listen({ host, port });
  return { server, address };
}

async function startKnowledgeProxy(target: string, queries: Record<string, unknown>[], state: KnowledgeProxyState): Promise<{ url: string; close(): Promise<void> }> {
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { payload?: { operation?: unknown; input?: unknown } };
        if (parsed.payload?.operation === "query" && parsed.payload.input && typeof parsed.payload.input === "object") {
          queries.push(parsed.payload.input as Record<string, unknown>);
        }
        if (parsed.payload?.operation === "import_document") state.importDispatchCount += 1;
      } catch {
        // Let the real module produce its protocol error for malformed input.
      }
    }
    try {
      const upstream = await fetch(new URL(request.url ?? "/", `${target}/`), {
        method: request.method,
        headers: { "content-type": String(request.headers["content-type"] ?? "application/json") },
        body: body.length > 0 ? body : undefined,
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      if (state.dropNextImportResponse && request.method === "POST" && request.url === "/v2/module/call") {
        const parsedRequest = body.length > 0 ? JSON.parse(body.toString("utf8")) as { payload?: { operation?: unknown } } : undefined;
        if (parsedRequest?.payload?.operation === "import_document") {
          const parsedResponse = JSON.parse(upstreamBody.toString("utf8")) as { payload?: { result?: { id?: unknown } } };
          const jobId = parsedResponse.payload?.result?.id;
          if (typeof jobId === "string" && jobId) state.lastDroppedImportJobId = jobId;
          state.dropNextImportResponse = false;
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "STAFFDECK_RESPONSE_LOST", message: "simulated lost response" } }));
          return;
        }
      }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(upstreamBody);
    } catch (error) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "STAFFDECK_UNAVAILABLE", message: String(error) } }));
    }
  });
  await listen(proxy);
  return { url: serverUrl(proxy), close: () => closeServer(proxy) };
}

async function routePilotDeckModule(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    calls: string[];
    knowledgeQueries: Record<string, unknown>[];
    projectRoot: string;
    baseId: string;
    phase: () => "initial" | "waiting" | "resumed";
    consumeAutomaticCompaction(): boolean;
    consumeManualCompaction(): boolean;
    realModel?: RealModelFixture;
  },
): Promise<void> {
  const path = request.url ?? "";
  const slot = path.includes("modelProvider") ? "modelProvider" : path.includes("tools") ? "tools" : path.includes("skills") ? "skills" : "context";
  const contract = slot === "modelProvider" ? "pilotdeck.model/v1" : slot === "tools" ? "pilotdeck.tools/v1" : slot === "skills" ? "pilotdeck.skills/v1" : "pilotdeck.context/v1";
  const methods = slot === "modelProvider" ? ["prepare", "stream"] : slot === "tools" ? ["execute"] : slot === "skills" ? ["list", "read"] : ["prepare_for_model", "apply_tool_results", "recover_from_model_error", "capture_turn", "try_auto_compact"];
  if (request.method === "GET") {
    writeJson(response, { protocolVersion: "2.0", implementationId: `real-e2e.${slot}`, contract, transport: "module-http-v2", methods });
    return;
  }
  const body = await readJson(request);
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const operation = String(payload.operation ?? (slot === "tools" ? "execute" : ""));
  options.calls.push(`${slot}:${operation}`);
  let result: unknown;
  if (slot === "skills" && operation === "list") {
    result = { builtin: [], user: [], project: [], projectPath: options.projectRoot, items: [{ slug: "approval-guide", name: "Approval Guide", description: "Approval evidence guide", skillFile: "/skills/approval-guide/SKILL.md" }] };
  } else if (slot === "skills" && operation === "read") {
    result = { content: "# Approval Guide\nAlways cite the approval policy.", scope: "project", slug: "approval-guide", skill: null };
  } else if (slot === "modelProvider" && operation === "prepare") {
    result = { prepared: { request: payload.request, provider: "real-e2e", model: "default" } };
  } else if (slot === "modelProvider" && operation === "stream") {
    const modelRequest = (payload.request ?? {}) as Record<string, unknown>;
    if (options.realModel) {
      const request = {
        ...modelRequest,
        provider: options.realModel.provider,
        model: options.realModel.model,
      } as CanonicalModelRequest;
      const events = [];
      for await (const event of options.realModel.runtime.stream(request)) events.push(event);
      result = { events };
      writeJson(response, { kind: "response", messageId: `response-${String(body.messageId)}`, inReplyTo: body.messageId, requestId: body.requestId, ok: true, payload: result });
      return;
    }
    const messages = JSON.stringify(modelRequest.messages ?? []);
    const current = options.phase();
    if (current === "resumed") {
      result = { events: [{ type: "request_started", provider: "real-e2e", model: "default" }, { type: "message_start", role: "assistant" }, ...toolCall("submit-completed", "submit_step_result", { status: "completed", replyFragment: "Operator-approved policy completed." }), { type: "message_end", finishReason: "tool_call" }] };
    } else if (!messages.includes("tool_result")) {
      result = { events: [{ type: "request_started", provider: "real-e2e", model: "default" }, { type: "message_start", role: "assistant" }, ...toolCall("skill-read", "read_skill", { skillName: "approval-guide" }), ...toolCall("remote-lookup", "remote_lookup", { key: "approval-policy" }), ...toolCall("knowledge-query", "knowledge_query", { tenantId: "tenant_demo", actorUserId: "admin", knowledgeBaseIds: [options.baseId], query: "owner approval before release", queryType: "answer", maxChunks: 8, maxBuckets: 4, budgetTokens: 4000, needEvidencePack: true }), { type: "message_end", finishReason: "tool_call" }] };
    } else {
      result = { events: [{ type: "request_started", provider: "real-e2e", model: "default" }, { type: "message_start", role: "assistant" }, ...toolCall("submit-handoff", "submit_step_result", { status: "handoff", replyFragment: "Waiting for operator approval." }), { type: "message_end", finishReason: "tool_call" }] };
    }
  } else if (slot === "tools") {
    result = { type: "success", toolCallId: payload.toolCallId, toolName: payload.name, content: [{ type: "text", text: "Remote approval record found." }], startedAt: "2026-09-19T00:00:00.000Z", completedAt: "2026-09-19T00:00:00.001Z" };
  } else if (operation === "apply_tool_results") {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const toolResultMessage = input.toolResultMessage;
    result = { messages: toolResultMessage === undefined ? messages : [...messages, toolResultMessage], ...(toolResultMessage === undefined ? {} : { appendedMessages: [toolResultMessage] }), diagnostics: [] };
  } else if (operation === "try_auto_compact") {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    const manual = input.trigger === "manual";
    const shouldCompact = manual ? options.consumeManualCompaction() : options.consumeAutomaticCompaction();
    const summary = { role: "assistant", content: [{ type: "text", text: manual ? "Real StaffDeck manual summary" : "Real StaffDeck automatic summary" }] };
    result = shouldCompact ? { type: "compacted", messages: [summary], tier: "full", snapshot: { tokens: 24, maxContextTokens: Number(input.maxContextTokens ?? 65536), warningRatio: 0.8, blockingRatio: 0.95, state: "ok", ratio: 0.1 }, result: { compactionId: `real-${manual ? "manual" : "auto"}-1`, trigger: manual ? "manual" : "auto", preTokens: 128, postTokens: 24, messagesSummarized: 1, summaryMessage: summary, boundaryMarker: summary, messagesToKeep: [], attachments: [], hookResults: [], diagnostics: [], summaryGenerated: true } } : { type: "skipped", snapshot: { tokens: 0, maxContextTokens: Number(input.maxContextTokens ?? 65536), warningRatio: 0.8, blockingRatio: 0.95, state: "ok", ratio: 0 } };
  } else if (operation === "recover_from_model_error") {
    result = { type: "give_up", reason: "real_e2e_not_needed" };
  } else if (operation === "capture_turn") {
    result = {};
  } else {
    const input = (payload.input ?? {}) as Record<string, unknown>;
    result = { messages: input.messages ?? [], systemPromptParts: [], tools: input.tools ?? [], diagnostics: [], boundaries: [] };
  }
  writeJson(response, { kind: "response", messageId: `response-${String(body.messageId)}`, inReplyTo: body.messageId, requestId: body.requestId, ok: true, payload: ["context", "skills"].includes(slot) ? { result } : result });
}

type RealModelFixture = Readonly<{
  runtime: ModelRuntime;
  provider: string;
  model: string;
}>;

class NativeOwnerScenarioModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];
  baseId = "";
  phase: "initial" | "resumed" | "completed" = "initial";

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "native-owner-e2e", model: "default" };
    yield { type: "message_start", role: "assistant" };
    if (this.phase === "completed") {
      yield { type: "text_delta", text: "Native owner history recorded." };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    if (this.phase === "resumed") {
      yield* toolCall("native-submit-completed", "submit_step_result", {
        status: "completed",
        replyFragment: "Native owner approval completed.",
      });
    } else if (!hasToolResult) {
      if ((request.tools ?? []).some((tool) => tool.name === "read_skill")) {
        yield* toolCall("native-read-skill", "read_skill", { skillName: "approval-guide" });
      }
      yield* toolCall("native-read-file", "read_file", { file_path: "approval-input.txt" });
      yield* toolCall("native-knowledge-query", "knowledge_query", {
        tenantId: "tenant_demo",
        actorUserId: "admin",
        knowledgeBaseIds: [this.baseId],
        query: "owner approval before release",
        queryType: "answer",
        maxChunks: 8,
        maxBuckets: 4,
        budgetTokens: 4000,
        needEvidencePack: true,
      });
    } else {
      yield* toolCall("native-submit-handoff", "submit_step_result", {
        status: "handoff",
        replyFragment: "Waiting for native owner approval.",
      });
    }
    yield { type: "message_end", finishReason: "tool_call" };
  }

  async complete(request: CanonicalModelRequest) {
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Native owner compaction summary." }],
      finishReason: "stop" as const,
    };
  }

  getCapabilities() {
    return {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsToolUse: true,
      maxContextTokens: 65_536,
      maxOutputTokens: 8_192,
    };
  }
  getMultimodal() { return { input: ["text" as const] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

function createRealModelFixture(pilotHome: string): RealModelFixture {
  const snapshot = loadPilotConfig({
    configPath: join(pilotHome, "pilotdeck.yaml"),
    env: { ...process.env, PILOT_HOME: pilotHome },
  });
  const configured = process.env.REAL_SEVEN_SLOT_MODEL;
  const [provider, model] = configured?.split("/") ?? [
    snapshot.config.agent.model.provider,
    snapshot.config.agent.model.model,
  ];
  if (!provider || !model || !snapshot.config.model.providers[provider]?.models[model]) {
    throw new Error(`Real seven-slot model '${configured ?? snapshot.config.agent.model.id}' is not configured in ${pilotHome}.`);
  }
  return {
    runtime: createModelRuntime(snapshot.config.model),
    provider,
    model,
  };
}

function sevenSlotConfig(input: { moduleEndpoint: string; knowledgeEndpoint: string; sopEndpoint: string; sidecarHost: string; sidecarPort: number; definitionsPath: string }): string {
  return `schemaVersion: 1
agent:
  model: real/default
model:
  providers:
    real:
      protocol: openai
      url: http://unused.invalid/v1
      apiKey: test-only
      models:
        default:
          capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 8192 }
modules:
  agentLoop:
    enabled: true
    implementationId: pilotdeck-agent-loop
    contract: pilotdeck.agent-loop/v1
    transport: module-tcp-v2
    host: ${input.sidecarHost}
    port: ${input.sidecarPort}
    methods: [execute, status, resume, ack]
  modelProvider:
    enabled: true
    implementationId: real-e2e.modelProvider
    contract: pilotdeck.model/v1
    transport: module-http-v2
    endpoint: ${input.moduleEndpoint}
    manifestPath: /manifest/modelProvider
    callPath: /call/modelProvider
    methods: [prepare, stream]
  tools:
    enabled: true
    implementationId: real-e2e.tools
    contract: pilotdeck.tools/v1
    transport: module-http-v2
    endpoint: ${input.moduleEndpoint}
    manifestPath: /manifest/tools
    callPath: /call/tools
    methods: [execute]
    catalog:
      - name: remote_lookup
        description: Look up the approval policy record.
        inputSchema: { type: object }
        readOnly: true
        concurrencySafe: true
  context:
    enabled: true
    implementationId: real-e2e.context
    contract: pilotdeck.context/v1
    transport: module-http-v2
    endpoint: ${input.moduleEndpoint}
    manifestPath: /manifest/context
    callPath: /call/context
    methods: [prepare_for_model, apply_tool_results, recover_from_model_error, capture_turn, try_auto_compact]
  skills:
    enabled: true
    implementationId: real-e2e.skills
    contract: pilotdeck.skills/v1
    transport: module-http-v2
    endpoint: ${input.moduleEndpoint}
    manifestPath: /manifest/skills
    callPath: /call/skills
    methods: [list, read]
  knowledge:
    enabled: true
    implementationId: staffdeck.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: ${input.knowledgeEndpoint}
    manifestPath: /module-manifest
    callPath: /v2/module/call
    methods: [list_bases, create_base, get_base, update_base, delete_base, list_versions, sync_base, publish_version, rollback_version, list_documents, get_document, import_document, import_okf, update_document, delete_document, list_document_buckets, update_bucket, list_bucket_chunks, update_chunk, get_job, list_jobs, cancel_job, list_okf_concepts, get_okf_concept, upsert_okf_concept, export_okf, lint_okf, list_discoveries, confirm_discovery, reject_discovery, query, resolve_citation]
  sop:
    enabled: true
    implementationId: staffdeck.portable-sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: ${input.sopEndpoint}
    manifestPath: /healthz
    definitionsPath: ${input.definitionsPath}
    defaultSopId: approval
`;
}

function nativeOwnerConfig(input: {
  knowledgeEndpoint: string;
  sopEndpoint: string;
  definitionsPath: string;
  skillsEnabled?: boolean;
}): string {
  return `schemaVersion: 1
agent:
  model: native-owner/default
model:
  providers:
    native-owner:
      protocol: openai
      url: http://unused.invalid/v1
      apiKey: test-only
      models:
        default:
          capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 8192 }
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  context: { enabled: true, provider: pilotdeck }
  skills: { enabled: ${input.skillsEnabled ?? true}, provider: pilotdeck }
  knowledge:
    enabled: true
    implementationId: staffdeck.knowledge
    contract: staffdeck.knowledge/v1
    transport: module-http-v2
    endpoint: ${input.knowledgeEndpoint}
    manifestPath: /module-manifest
    callPath: /v2/module/call
    methods: [create_base, import_document, get_job, query, resolve_citation]
  sop:
    enabled: true
    implementationId: staffdeck.portable-sop
    contract: sop.lifecycle/v2
    transport: sop-http-v2
    endpoint: ${input.sopEndpoint}
    manifestPath: /healthz
    definitionsPath: ${input.definitionsPath}
    defaultSopId: approval
`;
}

async function writeE2EArtifact(name: string, value: unknown, root: string): Promise<void> {
  const directory = process.env.PILOTDECK_E2E_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${JSON.stringify(sanitizeE2EArtifact(value, root), null, 2)}\n`, "utf8");
}

function sanitizeE2EArtifact(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replaceAll(root, "<workspace>");
  if (Array.isArray(value)) return value.map((item) => sanitizeE2EArtifact(item, root));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "replayWorkspacePath" ? item : sanitizeE2EArtifact(item, root),
  ]));
}

function projectSopState(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return {
    revision: source.revision,
    state: source.state,
    ...(source.wait && typeof source.wait === "object"
      ? { wait: { kind: (source.wait as Record<string, unknown>).kind } }
      : {}),
  };
}

function hasCompletedAutomaticCompaction(events: unknown[]): boolean {
  return events.some((event) => {
    if (!event || typeof event !== "object") return false;
    const record = event as Record<string, unknown>;
    const detail = record.detail;
    return record.type === "agent_status"
      && record.event === "compact_completed"
      && typeof detail === "object"
      && detail !== null
      && (detail as Record<string, unknown>).trigger === "auto"
      && (detail as Record<string, unknown>).status === "success";
  });
}

function isCompactionSummaryRequest(request: CanonicalModelRequest): boolean {
  return request.messages.some((message) => message.metadata?.purpose === "context-summary-control");
}

type SavedAutomaticCompactionTrigger = {
  input: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  decision: Record<string, unknown>;
  budgetEvaluations: Array<{
    messages: unknown[];
    snapshot: Record<string, unknown>;
    request: Record<string, unknown>;
    maxContextTokens: number;
    reservedOutputTokens: number;
    calibration?: Record<string, unknown>;
  }>;
  fullSummaryStarted: true;
  summaryMessages: unknown[];
  summaryPreTokens: number;
  summaryLocalEstimateTokens: number;
  summaryAccountingEstimateTokens: number;
};

function saveAutomaticCompactionTrigger(observation: CompactionAutomaticTriggerObservation): SavedAutomaticCompactionTrigger {
  const { abortSignal: _abortSignal, budgetEvaluator: _budgetEvaluator, ...input } = observation.input;
  return JSON.parse(JSON.stringify({
    input,
    snapshot: observation.snapshot,
    decision: observation.decision,
    budgetEvaluations: observation.budgetEvaluations,
    fullSummaryStarted: observation.fullSummaryStarted,
    summaryMessages: observation.summaryMessages,
    summaryPreTokens: observation.summaryPreTokens,
    summaryLocalEstimateTokens: observation.summaryLocalEstimateTokens,
    summaryAccountingEstimateTokens: observation.summaryAccountingEstimateTokens,
  })) as SavedAutomaticCompactionTrigger;
}

function evidenceCitationId(value: unknown): string {
  const record = value as Record<string, unknown>;
  const rows = record.evidence_pack;
  if (!Array.isArray(rows)) throw new Error(`Knowledge query returned no evidence pack: ${JSON.stringify(value)}`);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of ["chunk_id", "chunkId", "id"]) {
      const id = (row as Record<string, unknown>)[key];
      if (typeof id === "string" && id) return id;
    }
  }
  throw new Error(`Knowledge evidence has no citation id: ${JSON.stringify(value)}`);
}

async function pollKnowledgeJob(port: ReturnType<typeof createKnowledgeModulePort>, jobId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await port.call("get_job", { tenantId: "tenant_demo", actorUserId: "admin", jobId });
    const status = textField(job, "status");
    if (["succeeded", "completed", "success"].includes(status)) return;
    if (["failed", "cancelled"].includes(status)) throw new Error(`Knowledge job failed: ${JSON.stringify(job)}`);
    await delay(150);
  }
  throw new Error(`Knowledge job ${jobId} did not complete.`);
}

function textField(value: unknown, key: string): string {
  const result = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`Expected ${key} in ${JSON.stringify(value)}`);
  return result;
}

function toolCall(id: string, name: string, input: unknown): CanonicalModelEvent[] {
  return [{ type: "tool_call_start", id, name }, { type: "tool_call_end", toolCall: { id, name, input } }];
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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

async function freePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("free port server has no address");
  const port = address.port;
  await closeServer(server);
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
