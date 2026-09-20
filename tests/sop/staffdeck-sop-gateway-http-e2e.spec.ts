import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";

const endpoint = process.env.STAFFDECK_SOP_E2E_ENDPOINT;

test("Gateway runs PilotDeck tools through the real StaffDeck SOP HTTP service", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-gateway-http-"));
  const projectRoot = join(root, "project");
  const provider = await startOpenAiMock();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "onboarding.yaml"), ONBOARDING_YAML, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), configFor(endpoint!, provider.url), "utf8");

  let local = createSopGateway(projectRoot);
  try {
    const events = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sop:http:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Onboard Ada",
      mode: "bypassPermissions",
    })) {
      events.push(event);
    }

    const agentRequests = provider.requests.filter((request) => Array.isArray(request.tools));
    assert.equal(agentRequests.length, 2, JSON.stringify(events));
    assert.match(JSON.stringify(agentRequests[0]), /staffdeck-sop/);
    assert.match(JSON.stringify(agentRequests[0]), /submit_step_result/);
    assertTurnEndsAfterReply(events, "I found Ada's account and captured the onboarding details.");
    assert.deepEqual((await readState(projectRoot)).state, {
      version: 1,
      selected_skill_id: "onboarding",
      active_skill_id: "onboarding",
      active_step_id: "complete",
      status: "active",
      slots_json: { name: "Ada" },
      skill_stack_json: [],
      successful_tool_names: [],
      awaiting_input_json: null,
      summary: null,
    });

    // Recreate the complete Gateway process boundary. The second turn must
    // restore the durable SOP state rather than replay the lookup step.
    await local.dispose();
    local = createSopGateway(projectRoot);
    const requestsBeforeRestart = provider.requests.length;
    const completionEvents = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sop:http:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Confirm completion",
      mode: "bypassPermissions",
    })) {
      completionEvents.push(event);
    }

    assert.equal(provider.requests.filter((request) => Array.isArray(request.tools)).length, 3);
    assertTurnEndsAfterReply(completionEvents, "Onboarding is complete.");
    const restartedRequests = provider.requests.slice(requestsBeforeRestart);
    assert.equal(restartedRequests.length, 1);
    const completed = await readState(projectRoot);
    assert.equal(completed.state.status, "completed");
    assert.equal(completed.state.active_step_id, "complete");
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway leaves StaffDeck out of a disabled SOP composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-disabled-"));
  const projectRoot = join(root, "project");
  const provider = await startTextOpenAiMock("Native PilotDeck chat completed.");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), configWithoutSop(provider.url), "utf8");

  const local = createSopGateway(projectRoot);
  try {
    const events = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sop:disabled:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Complete a native chat turn",
      mode: "bypassPermissions",
    })) {
      events.push(event);
    }

    assertTurnEndsAfterReply(events, "Native PilotDeck chat completed.");
    const agentRequests = provider.requests.filter((request) => Array.isArray(request.tools));
    assert.equal(agentRequests.length, 1);
    assert.ok(!toolNames(agentRequests[0]).includes("submit_step_result"));
    await assert.rejects(access(join(projectRoot, "sop", "sessions")));
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway rejects the shipped onboarding SOP before model dispatch when lookup_account is not bound", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-missing-tool-"));
  const projectRoot = join(root, "project");
  const provider = await startMissingToolOpenAiMock();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "onboarding.yaml"), ONBOARDING_YAML, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), configFor(endpoint!, provider.url), "utf8");
  const local = createSopGateway(projectRoot, false);
  try {
    const events = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:missing-tool:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Onboard Ada without the declared business tool",
      mode: "bypassPermissions",
    }));
    assert.ok(events.some((event) => event.type === "error" && /requires unavailable PilotDeck tools: lookup_account/.test(event.message)), JSON.stringify(events));
    assert.equal(provider.requests.length, 0, "a missing required Tool must reject before model dispatch");
    await assert.rejects(access(join(projectRoot, "sop", "sessions")));
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway preserves an existing SOP wait across enabled-disabled-enabled profile restarts", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-profile-restart-"));
  const projectRoot = join(root, "project");
  const provider = await startLifecycleOpenAiMock();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "lifecycle.yaml"), LIFECYCLE_YAML, "utf8");
  await writeFile(
    join(projectRoot, "pilotdeck.yaml"),
    configForDefinition(endpoint!, provider.url, "lifecycle.yaml", "lifecycle"),
    "utf8",
  );

  let local = createSopGateway(projectRoot);
  try {
    await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:profile-restart",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Request human handoff",
      mode: "bypassPermissions",
    }));
    const waiting = await local.gateway.sopStatus!({ sessionKey: "sop:profile-restart", projectKey: projectRoot });
    assert.equal(waiting?.state.status, "handoff");
    assert.equal(waiting?.wait?.kind, "handoff");
    const expectedWaitId = waiting!.wait!.id;
    const expectedRevision = waiting!.revision;
    await local.dispose();

    await writeFile(join(projectRoot, "pilotdeck.yaml"), configWithoutSop(provider.url), "utf8");
    local = createSopGateway(projectRoot);
    await assert.rejects(
      () => local.gateway.sopStatus!({ sessionKey: "sop:profile-restart", projectKey: projectRoot }),
      (error: unknown) => (error as { code?: string }).code === "SOP_MODULE_DISABLED",
    );
    await local.dispose();

    await writeFile(
      join(projectRoot, "pilotdeck.yaml"),
      configForDefinition(endpoint!, provider.url, "lifecycle.yaml", "lifecycle"),
      "utf8",
    );
    local = createSopGateway(projectRoot);
    const restored = await local.gateway.sopStatus!({ sessionKey: "sop:profile-restart", projectKey: projectRoot });
    assert.equal(restored?.state.status, "handoff");
    assert.equal(restored?.wait?.id, expectedWaitId);
    assert.equal(restored?.revision, expectedRevision);
    assert.deepEqual(restored?.state.slots_json, waiting?.state.slots_json);
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway rejects a concurrent SOP turn for the same session without touching SOP state", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-concurrent-"));
  const projectRoot = join(root, "project");
  const provider = await startGatedTextOpenAiMock("The active SOP turn completed.");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "onboarding.yaml"), ONBOARDING_YAML, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), configFor(endpoint!, provider.url), "utf8");

  const local = createSopGateway(projectRoot);
  try {
    const first = collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:concurrent:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Start the active SOP turn",
      mode: "bypassPermissions",
    }));
    await provider.waitForAgentRequest();

    const second = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:concurrent:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "This turn must be rejected while the first is active",
      mode: "bypassPermissions",
    }));
    assert.ok(second.some((event) => event.type === "error" && event.code === "session_busy"), JSON.stringify(second));
    assert.equal(provider.agentRequestCount(), 1);

    provider.release();
    assertTurnEndsAfterReply(await first, "The active SOP turn completed.");
    assert.equal((await readState(projectRoot, "sop:concurrent:e2e")).state.status, "active");
  } finally {
    provider.release();
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway resumes StaffDeck handoff and external waits through host-side composition", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-resume-http-"));
  const projectRoot = join(root, "project");
  const provider = await startLifecycleOpenAiMock();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "lifecycle.yaml"), LIFECYCLE_YAML, "utf8");
  await writeFile(
    join(projectRoot, "pilotdeck.yaml"),
    configForDefinition(endpoint!, provider.url, "lifecycle.yaml", "lifecycle"),
    "utf8",
  );

  const local = createSopGateway(projectRoot);
  try {
    const handoffEvents = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:handoff:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Request human handoff",
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(handoffEvents, "Waiting for human approval.");
    const handoff = await local.gateway.sopStatus!({ sessionKey: "sop:handoff:e2e", projectKey: projectRoot });
    assert.equal(handoff?.state.status, "handoff");
    assert.equal(handoff?.wait?.kind, "handoff");

    const resumedHandoff = await local.gateway.resumeSop!({
      sessionKey: "sop:handoff:e2e",
      projectKey: projectRoot,
      requestId: "handoff-reply-1",
      waitId: handoff!.wait!.id,
      source: "human",
      message: "Human approved the request.",
      expectedRevision: handoff!.revision,
      slotUpdates: { humanApproved: true },
    });
    const duplicateHandoff = await local.gateway.resumeSop!({
      sessionKey: "sop:handoff:e2e",
      projectKey: projectRoot,
      requestId: "handoff-reply-1",
      waitId: handoff!.wait!.id,
      source: "human",
      message: "Human approved the request.",
    });
    assert.equal(resumedHandoff.duplicate, false);
    assert.equal(duplicateHandoff.duplicate, true);
    const handoffCompletion = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:handoff:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: resumedHandoff.message,
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(handoffCompletion, "Human-approved SOP completed.");
    assert.equal((await local.gateway.sopStatus!({ sessionKey: "sop:handoff:e2e", projectKey: projectRoot }))?.state.status, "completed");

    const externalEvents = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:external:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Start external task",
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(externalEvents, "Waiting for external task.");
    const external = await local.gateway.sopStatus!({ sessionKey: "sop:external:e2e", projectKey: projectRoot });
    assert.equal(external?.state.status, "waiting_external_task");
    assert.equal(external?.wait?.kind, "external_task");

    const resumedExternal = await local.gateway.resumeSop!({
      sessionKey: "sop:external:e2e",
      projectKey: projectRoot,
      requestId: "external-result-1",
      waitId: external!.wait!.id,
      source: "external_task",
      message: "External task completed successfully.",
      expectedRevision: external!.revision,
      slotUpdates: { externalResult: "approved" },
    });
    await assert.rejects(
      () => local.gateway.resumeSop!({
        sessionKey: "sop:external:e2e",
        projectKey: projectRoot,
        requestId: "stale-external-result",
        waitId: external!.wait!.id,
        source: "external_task",
        message: "Old callback",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_NOT_WAITING",
    );
    const externalCompletion = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:external:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: resumedExternal.message,
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(externalCompletion, "External-task SOP completed.");
    const externalCompleted = await local.gateway.sopStatus!({ sessionKey: "sop:external:e2e", projectKey: projectRoot });
    assert.equal(externalCompleted?.state.status, "completed");
    assert.equal(externalCompleted?.state.slots_json?.externalResult, "approved");
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway projects non-resumable StaffDeck SOP states through ordinary turns", { skip: !endpoint }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-nonresumable-http-"));
  const projectRoot = join(root, "project");
  const provider = await startLifecycleOpenAiMock();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "lifecycle.yaml"), LIFECYCLE_YAML, "utf8");
  await writeFile(
    join(projectRoot, "pilotdeck.yaml"),
    configForDefinition(endpoint!, provider.url, "lifecycle.yaml", "lifecycle"),
    "utf8",
  );

  const local = createSopGateway(projectRoot);
  try {
    for (const scenario of [
      {
        name: "awaiting-user",
        sessionKey: "sop:awaiting-user:e2e",
        start: "Request user information",
        waitingReply: "Waiting for user information.",
        continueWith: "Provide the requested user information.",
        completionReply: "User-information SOP completed.",
      },
      {
        name: "failed",
        sessionKey: "sop:failed:e2e",
        start: "Mark SOP as failed",
        waitingReply: "SOP step failed and needs another attempt.",
        continueWith: "Retry the failed SOP step.",
        completionReply: "Failed SOP recovered and completed.",
      },
    ]) {
      const initialEvents = await collectTurn(local.gateway.submitTurn({
        sessionKey: scenario.sessionKey,
        channelKey: "test",
        workspaceCwd: projectRoot,
        message: scenario.start,
        mode: "bypassPermissions",
      }));
      assertTurnEndsAfterReply(initialEvents, scenario.waitingReply);
      const initial = await local.gateway.sopStatus!({ sessionKey: scenario.sessionKey, projectKey: projectRoot });
      assert.equal(initial?.state.status, scenario.name === "awaiting-user" ? "awaiting_user" : "failed");
      assert.equal(initial?.wait, undefined);
      await assert.rejects(
        () => local.gateway.resumeSop!({
          sessionKey: scenario.sessionKey,
          projectKey: projectRoot,
          requestId: `${scenario.name}-invalid-resume`,
          waitId: "not-a-real-wait",
          source: "human",
          message: "This status must not use the host resume control.",
        }),
        (error: unknown) => (error as { code?: string }).code === "SOP_NOT_WAITING",
      );

      const continuationEvents = await collectTurn(local.gateway.submitTurn({
        sessionKey: scenario.sessionKey,
        channelKey: "test",
        workspaceCwd: projectRoot,
        message: scenario.continueWith,
        mode: "bypassPermissions",
      }));
      assertTurnEndsAfterReply(continuationEvents, scenario.completionReply);
      const completed = await local.gateway.sopStatus!({ sessionKey: scenario.sessionKey, projectKey: projectRoot });
      assert.equal(completed?.state.status, "completed");
      assert.equal(completed?.wait, undefined);
    }

    const blockedEvents = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:blocked:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Mark SOP as blocked",
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(blockedEvents, "SOP is blocked and cannot continue.");
    const blocked = await local.gateway.sopStatus!({ sessionKey: "sop:blocked:e2e", projectKey: projectRoot });
    assert.equal(blocked?.state.status, "blocked");
    assert.equal(blocked?.wait, undefined);
    await assert.rejects(
      () => local.gateway.resumeSop!({
        sessionKey: "sop:blocked:e2e",
        projectKey: projectRoot,
        requestId: "blocked-invalid-resume",
        waitId: "not-a-real-wait",
        source: "human",
        message: "Blocked states are terminal.",
      }),
      (error: unknown) => (error as { code?: string }).code === "SOP_NOT_WAITING",
    );
    const blockedRevision = blocked!.revision;
    const blockedContinuation = await collectTurn(local.gateway.submitTurn({
      sessionKey: "sop:blocked:e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "Try to continue a blocked SOP",
      mode: "bypassPermissions",
    }));
    assertTurnEndsAfterReply(blockedContinuation, "Blocked SOP remains terminal.");
    const stillBlocked = await local.gateway.sopStatus!({ sessionKey: "sop:blocked:e2e", projectKey: projectRoot });
    assert.equal(stillBlocked?.state.status, "blocked");
    assert.equal(stillBlocked?.revision, blockedRevision, "a terminal SOP must not be prepared or submitted again");
    assert.equal(stillBlocked?.wait, undefined);
  } finally {
    await local.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const fault of ["http_500", "malformed_200", "timeout"] as const) {
  test(`Gateway preserves SOP state and remains usable after ${fault}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `pilotdeck-sop-${fault}-`));
    const projectRoot = join(root, "project");
    const runtime = await startFaultInjectingSopRuntime(fault);
    const provider = await startSubmitOnlyOpenAiMock("Recovered SOP completed.");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "onboarding.yaml"), SINGLE_STEP_YAML, "utf8");
    await writeFile(
      join(projectRoot, "pilotdeck.yaml"),
      configForDefinition(runtime.url, provider.url, "onboarding.yaml", "onboarding", fault === "timeout" ? 20 : undefined),
      "utf8",
    );

    const local = createSopGateway(projectRoot);
    try {
      const failed = await collectTurn(local.gateway.submitTurn({
        sessionKey: `sop:${fault}:e2e`,
        channelKey: "test",
        workspaceCwd: projectRoot,
        message: "Trigger the injected SOP runtime failure",
        mode: "bypassPermissions",
      }));
      assert.ok(failed.some((event) => (event as { type?: string }).type === "error"), JSON.stringify(failed));
      const afterFailure = await readState(projectRoot, `sop:${fault}:e2e`);
      assert.equal(afterFailure.state.active_step_id, undefined);
      assert.equal(afterFailure.state.status, undefined);

      runtime.recover();
      const recovered = await collectTurn(local.gateway.submitTurn({
        sessionKey: `sop:${fault}:e2e`,
        channelKey: "test",
        workspaceCwd: projectRoot,
        message: "Retry after the SOP runtime recovers",
        mode: "bypassPermissions",
      }));
      assertTurnEndsAfterReply(recovered, "Recovered SOP completed.");
      assert.equal((await readState(projectRoot, `sop:${fault}:e2e`)).state.status, "completed");
    } finally {
      await local.dispose();
      await provider.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function createSopGateway(projectRoot: string, includeLookupAccount = true) {
  return createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    extraTools: includeLookupAccount ? [lookupAccountTool()] : [],
  });
}

function lookupAccountTool(): PilotDeckToolDefinition {
  return {
    name: "lookup_account",
    description: "Look up an account by id.",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "Account Ada exists." }] }),
  };
}

function configFor(sopEndpoint: string, modelEndpoint: string): string {
  return configForDefinition(sopEndpoint, modelEndpoint, "onboarding.yaml", "onboarding");
}

function configForDefinition(
  sopEndpoint: string,
  modelEndpoint: string,
  definitionsPath: string,
  defaultSopId: string,
  timeoutMs?: number,
): string {
  return `schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: ${modelEndpoint}
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: ${sopEndpoint}
    definitionsPath: ${definitionsPath}
    defaultSopId: ${defaultSopId}
${timeoutMs === undefined ? "" : `    timeoutMs: ${timeoutMs}\n`}`;
}

function configWithoutSop(modelEndpoint: string): string {
  return `schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: ${modelEndpoint}
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop: { enabled: false, provider: staffdeck }
`;
}

async function startMissingToolOpenAiMock(): Promise<{ url: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  let streamedRequests = 0;
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"title":"Missing binding"}' }, finish_reason: "stop" }] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (streamedRequests++ === 0) {
      writeToolCall(response, "missing-lookup", "lookup_account", { accountId: "ada" });
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lookup_account is not bound for this deployment." }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await listen(server);
  return { url: serverUrl(server), requests, close: () => closeServer(server) };
}

async function startOpenAiMock(): Promise<{ url: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"title":"SOP E2E"}' }, finish_reason: "stop" }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const tools = Array.isArray(body.tools);
    const serializedMessages = JSON.stringify(body.messages ?? []);
    if (!tools) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "SOP E2E" }, finish_reason: "stop" }] })}\n\n`);
    } else if (serializedMessages.includes("lookup-account")) {
      writeToolCall(response, "submit-sop-step", "submit_step_result", {
        status: "completed",
        replyFragment: serializedMessages.includes("submit-sop-step")
          ? "Onboarding is complete."
          : "I found Ada's account and captured the onboarding details.",
        ...(serializedMessages.includes("submit-sop-step") ? {} : { slotUpdates: { name: "Ada" } }),
      });
    } else {
      writeToolCall(response, "lookup-account", "lookup_account", { accountId: "ada" });
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenAI mock did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

async function startTextOpenAiMock(text: string): Promise<{ url: string; requests: Record<string, unknown>[]; close(): Promise<void> }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenAI mock did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

async function startGatedTextOpenAiMock(text: string): Promise<{
  url: string;
  waitForAgentRequest(): Promise<void>;
  agentRequestCount(): number;
  release(): void;
  close(): Promise<void>;
}> {
  let agentRequests = 0;
  let started!: () => void;
  const firstAgentRequest = new Promise<void>((resolve) => { started = resolve; });
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"title":"Concurrent SOP"}' }, finish_reason: "stop" }],
      }));
      return;
    }
    if (Array.isArray(body.tools)) {
      agentRequests += 1;
      if (agentRequests === 1) started();
      await gate;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenAI mock did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    waitForAgentRequest: () => firstAgentRequest,
    agentRequestCount: () => agentRequests,
    release: () => releaseGate(),
    close: () => closeServer(server),
  };
}

async function startLifecycleOpenAiMock(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"title":"SOP lifecycle"}' }, finish_reason: "stop" }],
      }));
      return;
    }
    const messages = JSON.stringify(body.messages ?? []);
    let status: "completed" | "awaiting_user" | "handoff" | "failed" | "blocked" | "waiting_external_task" = "completed";
    let replyFragment = "SOP completed.";
    if (messages.includes("Request user information") && !messages.includes("Provide the requested user information")) {
      status = "awaiting_user";
      replyFragment = "Waiting for user information.";
    } else if (messages.includes("Provide the requested user information")) {
      replyFragment = "User-information SOP completed.";
    } else if (messages.includes("Mark SOP as failed") && !messages.includes("Retry the failed SOP step")) {
      status = "failed";
      replyFragment = "SOP step failed and needs another attempt.";
    } else if (messages.includes("Retry the failed SOP step")) {
      replyFragment = "Failed SOP recovered and completed.";
    } else if (messages.includes("Try to continue a blocked SOP")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Blocked SOP remains terminal." }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    } else if (messages.includes("Mark SOP as blocked")) {
      status = "blocked";
      replyFragment = "SOP is blocked and cannot continue.";
    } else if (messages.includes("Request human handoff") && !messages.includes("Human approved the request")) {
      status = "handoff";
      replyFragment = "Waiting for human approval.";
    } else if (messages.includes("Human approved the request")) {
      replyFragment = "Human-approved SOP completed.";
    } else if (messages.includes("Start external task") && !messages.includes("External task completed successfully")) {
      status = "waiting_external_task";
      replyFragment = "Waiting for external task.";
    } else if (messages.includes("External task completed successfully")) {
      replyFragment = "External-task SOP completed.";
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    writeToolCall(response, `lifecycle-${status}`, "submit_step_result", { status, replyFragment });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenAI mock did not bind a TCP port.");
  return { url: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
}

async function startSubmitOnlyOpenAiMock(replyFragment: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"title":"SOP fault recovery"}' }, finish_reason: "stop" }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    writeToolCall(response, "submit-after-recovery", "submit_step_result", { status: "completed", replyFragment });
    response.end("data: [DONE]\n\n");
  });
  await listen(server);
  return { url: serverUrl(server), close: () => closeServer(server) };
}

async function startFaultInjectingSopRuntime(fault: "http_500" | "malformed_200" | "timeout"): Promise<{
  url: string;
  recover(): void;
  close(): Promise<void>;
}> {
  let faultActive = true;
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        protocolVersion: "2.0",
        moduleId: "sop.runtime",
        contract: "sop.lifecycle/v2",
        operations: ["prepare", "submit"],
      }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      requestId?: string;
      payload?: {
        state?: Record<string, unknown>;
        proposal?: { replyFragment?: string };
      };
    };
    if (request.url === "/v1/sop/prepare") {
      if (faultActive) {
        if (fault === "http_500") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({
            protocolVersion: "2.0", requestId: body.requestId, ok: false, outcome: "failed",
            error: { code: "INJECTED_FAILURE", message: "Injected SOP failure.", retryability: "safe", details: {} },
          }));
          return;
        }
        if (fault === "malformed_200") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("[]");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed",
        payload: {
          state: {
            ...(body.payload?.state ?? {}),
            active_skill_id: "onboarding",
            active_step_id: "only",
            status: "active",
            awaiting_input_json: null,
          },
          step: {
            skillId: "onboarding",
            skillName: "Fault recovery",
            version: "1",
            nodeId: "only",
            node: {},
            instruction: "Complete the recovered SOP step.",
            expectedUserInfo: [],
            knownSlots: {},
            allowedNextStepIds: [],
            requiredToolNames: [],
            allowedActions: [],
            isTerminal: true,
            declaresHandoff: false,
          },
        },
      }));
      return;
    }
    if (request.url === "/v1/sop/submit") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed",
        payload: {
          state: { ...(body.payload?.state ?? {}), status: "completed" },
          result: {
            status: "completed",
            replyFragment: body.payload?.proposal?.replyFragment ?? "Recovered SOP completed.",
            slotUpdates: {},
            events: [],
          },
        },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server);
  return {
    url: serverUrl(server),
    recover: () => { faultActive = false; },
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function readState(projectRoot: string, sessionId = "sop:http:e2e"): Promise<{ state: Record<string, unknown> }> {
  return JSON.parse(await readFile(
    join(projectRoot, "sop", "sessions", `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`),
    "utf8",
  ));
}

async function collectTurn<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function assertTurnEndsAfterReply(events: Array<{ type: string; [key: string]: unknown }>, reply: string): void {
  const replyIndex = events.findIndex((event) => (
    (event.type === "assistant_block" || event.type === "assistant_text_delta")
    && event.text === reply
  ));
  const completeIndex = events.findIndex((event) => event.type === "turn_completed");
  assert.ok(replyIndex >= 0, `missing final reply '${reply}': ${JSON.stringify(events)}`);
  assert.ok(completeIndex > replyIndex, "turn_completed must follow the durable SOP reply");
}

function writeToolCall(response: ServerResponse, id: string, name: string, input: unknown): void {
  response.write(`data: ${JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] },
      finish_reason: "tool_calls",
    }],
  })}\n\n`);
}

function toolNames(request: Record<string, unknown>): string[] {
  const tools = request.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return [];
    const fn = (tool as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null || Array.isArray(fn)) return [];
    const name = (fn as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const ONBOARDING_YAML = `sops:
  - id: onboarding
    version: "1"
    name: Account onboarding
    content:
      start_node_id: collect_profile
      nodes:
        - node_id: collect_profile
          instruction: Collect the user's name and run lookup_account before confirming onboarding.
          expected_user_info: [name]
          allowed_actions: ["call_tool:lookup_account"]
        - node_id: complete
          instruction: Confirm that onboarding is complete.
      edges:
        - source_node_id: collect_profile
          next_node_id: complete
      terminal_node_ids: [complete]
`;

const LIFECYCLE_YAML = `sops:
  - id: lifecycle
    version: "1"
    name: Resumable lifecycle
    content:
      start_node_id: approval
      nodes:
        - node_id: approval
          type: handoff
          instruction: Complete this step after any requested host-side wait is resumed.
      terminal_node_ids: [approval]
`;

const SINGLE_STEP_YAML = `sops:
  - id: onboarding
    version: "1"
    name: Fault recovery
    content:
      start_node_id: only
      nodes:
        - node_id: only
          instruction: Complete the recovered SOP step.
      terminal_node_ids: [only]
`;
