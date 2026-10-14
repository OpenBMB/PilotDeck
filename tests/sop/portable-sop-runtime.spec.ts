import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { PortableSopRuntimeClient, PortableSopHostClient } from "../../src/sop/staffdeck/PortableSopRuntimeClient.js";
import { SopStateStore } from "../../src/sop/staffdeck/SopStateStore.js";
import { SopAgentLoop } from "../../src/sop/staffdeck/SopAgentLoop.js";
import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import type { ModelInvokerPort, ToolPort } from "../../src/agent/modules/protocol.js";
import type { ProtocolSopRuntimeConfig, StaffDeckSopBundle } from "../../src/sop/staffdeck/types.js";

test("PilotDeck AgentLoop executes against independent HTTP Runtime and recovers authoritative state", {
  skip: !process.env.SOP_RUNTIME_PYTHON || !process.env.SOP_RUNTIME_SOURCE,
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-sop-"));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const child = spawn(process.env.SOP_RUNTIME_PYTHON!, ["-m", "uvicorn", "staffdeck_sop_runtime.api:app",
    "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, PYTHONPATH: process.env.SOP_RUNTIME_SOURCE,
      SOP_RUNTIME_DB: join(root, "runtime.sqlite") }, stdio: "ignore",
  });
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${endpoint}/healthz`)).ok; } catch { /* Startup race. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, "Runtime must start without StaffDeck backend on PYTHONPATH");
    const runtime = new PortableSopRuntimeClient(endpoint);
    const bundle: StaffDeckSopBundle = { sops: [{ id: "flow", version: "1", content: {
      start_node_id: "lookup", nodes: [{ node_id: "lookup", allowed_actions: ["call_tool:lookup"] }], terminal_node_ids: ["lookup"],
    } }] };
    await runtime.publishDefinition({ sop_id: "flow", version: "1", content: bundle.sops[0].content });
    const profile: ProtocolSopRuntimeConfig = { implementationId: "portable-sop", contract: "sop.lifecycle/v3",
      transport: "sop-http-v3", manifestPath: "/healthz", endpoint, definitionsPath: "unused", defaultSopId: "flow", stateRoot: root };
    let invocation = 0;
    const model: ModelInvokerPort = {
      async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        if (invocation > 6) throw new Error("SOP submission did not converge");
        const toolCall = ++invocation === 1 ? { id: "lookup-call", name: "lookup", input: {} }
          : { id: "submit-call", name: "submit_step_result", input: { status: "completed", replyFragment: "Done" } };
        yield { type: "message_start", role: "assistant" };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
      },
    };
    const tools: ToolPort = { list: () => [{ name: "lookup", description: "Lookup", kind: "custom",
      inputSchema: { type: "object" }, isReadOnly: () => true, isConcurrencySafe: () => true,
      execute: async () => ({ content: [{ type: "text", text: "found" }] }) }],
      async executeAll(calls) { return calls.map(call => ({ type: "success" as const, toolName: call.name,
        toolCallId: call.id, content: [{ type: "text" as const, text: "found" }],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })); } };
    const session = createAgentSession({ sessionId: "host-session", config: { provider: "test", model: "test",
      cwd: root, permissionMode: "default", permissionContext: createDefaultPermissionContext({ cwd: root, canPrompt: false }), staffDeckSop: profile },
      dependencies: { router: {} as never, ports: { model, tools }, tools: {
        registry: { list: () => tools.list() } as never, scheduler: { executeAll: async () => [] } as never } },
      agentLoopFactory: input => new SopAgentLoop(input.config, input.capabilities, input.seedState, { profile, bundle }),
    });
    const events = [];
    for await (const event of session.submit({ type: "text", text: "Start" }, { turnId: "turn" })) events.push(event);
    const remote = await runtime.session("host-session");
    assert.equal(remote.state.status, "completed", JSON.stringify(events.filter(event => event.type === "tool_result")));
    assert.equal(remote.state.revision, 1, "preparation and host receipts must not increment Runtime revision");
    assert.deepEqual(remote.state.metadata.consumed_receipt_ids, ["turn:lookup:lookup-call:lookup"]);
    await rm(join(root, "sessions"), { recursive: true, force: true });
    const recovered = await new SopStateStore(join(root, "sessions"), runtime).status("host-session");
    assert.equal(recovered?.state.status, "completed");
    assert.equal(recovered?.revision, 1);
    // Native catalog discovery and replaceable capabilities use logical IDs,
    // with no StaffDeck authority or local definition file.
    for (const scenario of ['success', 'missing', 'failed'] as const) {
      const id = `native-${scenario}`;
      const refs = { required_tool_ids: ['tool-resource'], required_general_skill_ids: ['skill-resource'], required_knowledge_base_ids: ['knowledge-resource'] };
      const content = { skill_id: id, version: '1', start_node_id: 'lookup', terminal_node_ids: ['lookup'], nodes: [{ node_id: 'lookup', capability_refs: refs }], edges: [] };
      const manage = async (operation: string, input: object) => {
        const response = await fetch(`${endpoint}/v1/management/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
        assert.ok(response.ok); return (await response.json()).result;
      };
      const draft = await manage('create', { content });
      await manage('publish', { sopId: id, draftId: draft.id, expectedRevision: 0 });
      const bindings = [{ kind: 'tool' as const, capabilityId: 'tool-resource', toolName: 'lookup' },
        { kind: 'skill' as const, capabilityId: 'skill-resource', toolName: 'lookup' },
        { kind: 'knowledge' as const, capabilityId: 'knowledge-resource', toolName: 'lookup' }];
      const nativeProfile = { ...profile, hostAdapter: 'pilotdeck' as const, defaultSopId: id,
        capabilityBindings: scenario === 'missing' ? bindings.slice(0, 2) : bindings };
      let count = 0;
      const nativeModel: ModelInvokerPort = { prepare: model.prepare,
        async *stream(): AsyncIterable<CanonicalModelEvent> {
          if (++count > 5) throw new Error('stop failed capability case');
          const toolCall = count === 1 ? { id: 'lookup', name: 'lookup', input: {} }
            : { id: `submit${count}`, name: 'submit_step_result', input: { status: 'completed', replyFragment: 'Done' } };
          yield { type: 'message_start', role: 'assistant' }; yield { type: 'tool_call_start', id: toolCall.id, name: toolCall.name };
          yield { type: 'tool_call_end', toolCall }; yield { type: 'message_end', finishReason: 'tool_call' };
        },
      };
      const nativeTools: ToolPort = scenario === 'failed' ? { list: tools.list, async executeAll(calls) { return calls.map(call => ({ type: 'error' as const, toolName: call.name, toolCallId: call.id,
        content: [{ type: 'text' as const, text: 'Knowledge double failure' }], error: { code: 'tool_execution_failed', message: 'Knowledge double failure' }, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() })); } } : tools;
      const nativeSession = createAgentSession({ sessionId: id, config: { provider: 'test', model: 'test', cwd: root,
        permissionMode: 'default', permissionContext: createDefaultPermissionContext({ cwd: root, canPrompt: false }), staffDeckSop: nativeProfile },
        dependencies: { router: {} as never, ports: { model: nativeModel, tools: nativeTools }, tools: {
          registry: { list: () => nativeTools.list() } as never, scheduler: { executeAll: async () => [] } as never } },
        agentLoopFactory: input => new SopAgentLoop(input.config, input.capabilities, input.seedState, { profile: nativeProfile, bundle: { sops: [] } }),
      });
      try { for await (const _event of nativeSession.submit({ type: 'text', text: 'Start' }, { turnId: 'native-turn' })) { /* Consume the real loop. */ } }
      catch (error) { if (scenario === 'success') throw error; }
      const nativeState = await runtime.session(id);
      assert.equal(nativeState.state.status, scenario === 'success' ? 'completed' : 'active', scenario);
      if (scenario === 'success') assert.equal((nativeState.state.metadata.consumed_receipt_ids as string[]).length, 3);
    }
    const host = new PortableSopHostClient(runtime);
    const conformanceCases = JSON.parse(await readFile(join(process.env.SOP_RUNTIME_SOURCE!,
      "../tests/fixtures/host_conformance.json"), "utf8")) as Array<{
      id: string; kind?: string; status: string; receipt?: boolean; required_field?: string;
      node_type?: string; next_node_id?: string; error?: string; expected_status?: string;
      expected_revision?: number; resume?: boolean;
    }>;
    for (const spec of conformanceCases) {
      const sessionId = `conformance-${spec.id}`;
      const content = { start_node_id: "work", terminal_node_ids: ["work"], nodes: [{
        node_id: "work", type: spec.node_type ?? "tool",
        ...(spec.required_field ? { expected_user_info: [spec.required_field] } : {}),
      }], ...(spec.kind ? { capability_requirements: [{ kind: spec.kind, capability_id: "double", node_id: "work", required: true }] } : {}) };
      await runtime.publishDefinition({ sop_id: sessionId, version: "1", content });
      const caseBundle: StaffDeckSopBundle = { sops: [{ id: sessionId, version: "1", content }] };
      const context = { runId: "run", sessionId, turnId: "turn", operationId: "prepare", requestId: "prepare" };
      const prepared = await host.prepare({ bundle: caseBundle, state: { selected_skill_id: sessionId }, context });
      const submission = { bundle: caseBundle, state: prepared.state, successfulToolNames: [],
        proposal: { status: spec.status, replyFragment: "Result", nextStepId: spec.next_node_id } as Parameters<typeof host.submit>[0]["proposal"],
        receipts: spec.receipt ? [{ capabilityId: "double", operationId: "call", nodeId: "work", sessionId, turnId: "turn", status: "succeeded" as const }] : [],
        context: { ...context, requestId: "submit", operationId: "submit", expectedRevision: 0 } };
      if (spec.error) await assert.rejects(host.submit(submission), { code: spec.error });
      else await host.submit(submission);
      const remote = await runtime.session(sessionId);
      assert.equal(remote.state.status, spec.expected_status ?? "active", spec.id);
      assert.equal(remote.state.revision, spec.expected_revision ?? 0, spec.id);
      if (spec.resume) {
        const input = { protocolVersion: "3.0" as const, sessionId, turnId: "resume", requestId: "resume", operationId: "resume",
          expectedRevision: 1, waitId: String(remote.state.pending_wait!.wait_id), slotUpdates: { name: "Ada" }, response: { source: "human" } };
        assert.deepEqual(await runtime.resume(input), await runtime.resume(input));
        await host.submit({ ...submission, proposal: { status: "completed", replyFragment: "Finished" },
          context: { ...context, turnId: "finish", requestId: "finish", operationId: "finish", expectedRevision: 2 } });
        assert.equal((await runtime.session(sessionId)).state.status, "completed", spec.id);
      }
    }
    const waits = { sop_id: "waits", version: "1", content: { start_node_id: "collect", nodes: [
      { node_id: "collect", expected_user_info: ["name"] }, { node_id: "done" }],
      edges: [{ source_node_id: "collect", next_node_id: "done" }], terminal_node_ids: ["done"] } };
    await runtime.publishDefinition(waits);
    const waitBundle: StaffDeckSopBundle = { sops: [{ id: "waits", version: "1", content: waits.content }] };
    const context = { runId: "run", sessionId: "wait-session", turnId: "wait-turn", operationId: "prepare", requestId: "prepare" };
    const prepared = await host.prepare({ bundle: waitBundle, state: { selected_skill_id: "waits" }, context });
    const waiting = await host.submit({ bundle: waitBundle, state: prepared.state, successfulToolNames: [],
      proposal: { status: "awaiting_user", replyFragment: "Name?" }, context: { ...context, operationId: "submit", requestId: "wait", expectedRevision: 0 } });
    assert.equal(waiting.state.status, "awaiting_user");
    const wait = waiting.state.awaiting_input_json as { wait_id: string };
    const resume = { protocolVersion: "3.0" as const, sessionId: "wait-session", turnId: "resume-turn",
      requestId: "resume", operationId: "resume", expectedRevision: 1, waitId: wait.wait_id, slotUpdates: { name: "Ada" } };
    assert.deepEqual(await runtime.resume(resume), await runtime.resume(resume));
    await host.submit({ bundle: waitBundle, state: waiting.state, successfulToolNames: [],
      proposal: { status: "completed", replyFragment: "Collected" }, context: { ...context, operationId: "advance", requestId: "advance", expectedRevision: 2 } });
    await host.submit({ bundle: waitBundle, state: waiting.state, successfulToolNames: [],
      proposal: { status: "completed", replyFragment: "Done" }, context: { ...context, operationId: "complete", requestId: "complete", expectedRevision: 3 } });
    assert.equal((await runtime.session("wait-session")).state.status, "completed");

    const scopedId = JSON.stringify(["staffdeck", "tenant", "agent", "local"]);
    await runtime.publishDefinition({ sop_id: scopedId, version: "1", content: waits.content });
    const scopedHost = new PortableSopHostClient(runtime, [], { tenantId: "tenant", agentId: "agent" });
    const scoped = await scopedHost.prepare({ bundle: { sops: [{ id: "local", version: "1", content: waits.content }] },
      state: { selected_skill_id: "local" }, context: { ...context, sessionId: "scoped-session", requestId: "scoped" } });
    assert.equal((await runtime.session("scoped-session")).state.sop_id, scopedId);
    assert.equal(scoped.state.active_skill_id, "local");
    assert.equal(scoped.step.skillId, "local");
    const scopedStore = new SopStateStore(join(root, "scoped-projection"), runtime);
    const restoredScoped = await scopedStore.loadOrCreate("scoped-session", { sops: [] }, "local");
    assert.equal(restoredScoped.bundle.sops[0].id, "local");
    const replayContext = { ...context, sessionId: "scoped-session", requestId: "scoped-replay", expectedRevision: 0 };
    const firstScopedPrepare = await scopedHost.prepare({ bundle: restoredScoped.bundle,
      state: restoredScoped.state, context: replayContext });
    const rereadScoped = await scopedStore.loadOrCreate("scoped-session", restoredScoped.bundle, "local");
    assert.deepEqual(await scopedHost.prepare({ bundle: rereadScoped.bundle,
      state: rereadScoped.state, context: replayContext }), firstScopedPrepare);

    for (const kind of ["tool", "skill", "knowledge"] as const) {
      const sopId = `capability-${kind}`;
      const definition = { sop_id: sopId, version: "1", content: { start_node_id: "invoke",
        nodes: [{ node_id: "invoke" }], terminal_node_ids: ["invoke"] },
        capability_requirements: [{ kind, capability_id: "host-double", node_id: "invoke", required: true }] };
      await runtime.publishDefinition(definition);
      await runtime.prepare({ protocolVersion: "3.0", sessionId: sopId, sopId,
        requestId: "prepare", operationId: "prepare", turnId: "turn" });
      const submission = { protocolVersion: "3.0" as const, sessionId: sopId, requestId: "submit",
        operationId: "submit", turnId: "turn", expectedRevision: 0,
        proposal: { status: "completed", reply: "Done" } };
      await assert.rejects(runtime.submit(submission), { code: "REQUIRED_CAPABILITY_NOT_INVOKED" });
      await assert.rejects(runtime.submit({ ...submission, receipts: [{ capabilityId: "host-double",
        operationId: "call", nodeId: "other", sessionId: sopId, turnId: "turn", status: "succeeded" }] }),
      { code: "RECEIPT_SCOPE_MISMATCH" });
      const completed = await runtime.submit({ ...submission, receipts: [{ capabilityId: "host-double",
        operationId: "call", nodeId: "invoke", sessionId: sopId, turnId: "turn", status: "succeeded" }] });
      assert.equal((completed.state as { status: string }).status, "completed");
      assert.deepEqual(await runtime.submit({ ...submission, receipts: [{ capabilityId: "host-double",
        operationId: "call", nodeId: "invoke", sessionId: sopId, turnId: "turn", status: "succeeded" }] }), completed);
      await assert.rejects(runtime.submit({ ...submission, requestId: "stale", operationId: "stale" }),
        { code: "SOP_REVISION_CONFLICT" });
    }

    for (const status of ["handoff", "waiting_external_task"] as const) {
      const sessionId = `host-${status}`;
      const definition = { sop_id: sessionId, version: "1", content: { start_node_id: "wait", nodes: [
        { node_id: "wait", type: status === "handoff" ? "handoff" : "tool_call", assignee_user_id: "reviewer" },
        { node_id: "done" }], edges: [{ source_node_id: "wait", next_node_id: "done" }], terminal_node_ids: ["done"] } };
      await runtime.publishDefinition(definition);
      await runtime.prepare({ protocolVersion: "3.0", sessionId, sopId: sessionId,
        requestId: "prepare", operationId: "prepare", turnId: "turn" });
      await runtime.submit({ protocolVersion: "3.0", sessionId, requestId: "wait", operationId: "wait",
        turnId: "turn", expectedRevision: 0, proposal: { status, reply: "Waiting" } });
      let store = new SopStateStore(join(root, "approval-tests"), runtime);
      const pending = await store.status(sessionId);
      assert.ok(pending?.wait);
      const input = { sessionId, requestId: "resume", waitId: pending.wait.id,
        expectedRevision: pending.revision, source: status === "handoff" ? "human" as const : "external_task" as const,
        message: "Approved", slotUpdates: { approved: true },
        ...(status === "handoff" ? { authority: { tenantId: "tenant", sessionId, subject: {
          tenantId: "tenant", userId: "reviewer", source: "web" as const, role: "member" as const, disabled: false } } } : {}) };
      if (status === "handoff") {
        await assert.rejects(store.resume({ ...input, authority: undefined }), { code: "SOP_APPROVAL_AUTH_REQUIRED" });
        const persistence = store as unknown as { write(value: { resumeIntent?: unknown; resumeRequests?: Record<string, unknown> }): Promise<void> };
        const originalWrite = persistence.write.bind(store);
        persistence.write = async value => {
          if (!value.resumeIntent && value.resumeRequests?.resume) throw new Error('crash after Runtime resume before local receipt');
          await originalWrite(value);
        };
        await assert.rejects(store.resume(input), /crash after Runtime/);
        assert.equal((await runtime.session(sessionId)).state.revision, 2);
        store = new SopStateStore(join(root, "approval-tests"), runtime);
        // A status refresh sees the new Runtime revision but must retain the
        // original durable resume command so its idempotent replay still works.
        assert.equal((await store.status(sessionId))!.revision, 2);
      }
      const resumed = await store.resume(input);
      assert.equal(resumed.revision, 2);
      assert.equal((await store.resume(input)).duplicate, true);
      assert.equal((await runtime.session(sessionId)).state.revision, 2);
      await runtime.submit({ protocolVersion: "3.0", sessionId, requestId: "advance", operationId: "advance",
        turnId: "after", expectedRevision: 2, proposal: { status: "completed", reply: "Approved" } });
      await runtime.submit({ protocolVersion: "3.0", sessionId, requestId: "done", operationId: "done",
        turnId: "after", expectedRevision: 3, proposal: { status: "completed", reply: "Done" } });
      assert.equal((await runtime.session(sessionId)).state.status, "completed");
    }
  } finally {
    child.kill();
    await exit;
    await rm(root, { recursive: true, force: true });
  }
});
