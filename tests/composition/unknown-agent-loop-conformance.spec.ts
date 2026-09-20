import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLoopSidecarServer,
  AgentLoopSidecarTcpServer,
  type AgentLoop,
  type AgentLoopRunResult,
} from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { createAgentLoopBindingFactory } from "../../src/cli/AgentLoopDeploymentProfile.js";
import { createAgentSession } from "../../src/agent/session/createAgentSession.js";
import { parseModulesConfig } from "../../src/pilot/config/parseModulesConfig.js";
import type { PilotConfigDiagnostic } from "../../src/pilot/config/types.js";
import { isExternalAgentLoopBinding } from "../../src/composition/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { ModelInvokerPort, ToolPort } from "../../src/agent/modules/protocol.js";
import type { ModuleCapabilities } from "../../src/agent/modules/protocol.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

/**
 * PLUG-02: a previously unregistered AgentLoop implementation must be usable
 * by changing only the protocol binding. The implementation below deliberately
 * has no host-side factory or allow-list entry.
 */
test("unknown AgentLoop implementation executes through YAML TCP binding", async (t) => {
  const sidecar = createUnknownLoopSidecar("unknown.agent-loop");
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({
    agentLoop: {
      enabled: true,
      implementationId: "unknown.agent-loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-tcp-v2",
      host: address.host,
      port: address.port,
      methods: ["execute", "cancel", "status", "resume", "ack"],
    },
  }, "/tmp/unknown-agent-loop-conformance", diagnostics);

  assert.equal(diagnostics.filter((item) => item.severity === "fatal").length, 0, JSON.stringify(diagnostics));
  assert.ok(modules?.agentLoop && isExternalAgentLoopBinding(modules.agentLoop));
  assert.equal(modules.agentLoop.implementationId, "unknown.agent-loop");

  const session = createAgentSession({
    sessionId: "unknown-agent-loop-session",
    config: runtimeConfig(),
    transcript: new InMemoryTranscriptWriter(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopBindingFactory(modules!.agentLoop!),
  });

  const events = [];
  for await (const event of session.submit({ type: "text", text: "execute unknown implementation" }, {
    turnId: "unknown-agent-loop-turn",
    execution: { runId: "unknown-agent-loop-run", operationId: "unknown-agent-loop-operation" },
  })) events.push(event);

  assert.equal(
    events.some((event) => event.type === "warning" && event.message === "unknown implementation executed"),
    true,
    JSON.stringify(events),
  );
  const completed = events.filter((event) => event.type === "turn_completed");
  assert.equal(completed.length, 1, JSON.stringify(events));
  assert.equal((completed[0] as { result?: { type?: string } }).result?.type, "success");
});

test("unknown AgentLoop identity mismatch is rejected before execute", async (t) => {
  const sidecar = createUnknownLoopSidecar("different.agent-loop");
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({
    agentLoop: {
      enabled: true,
      implementationId: "unknown.agent-loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-tcp-v2",
      host: address.host,
      port: address.port,
      methods: ["execute", "cancel", "status", "resume", "ack"],
    },
  }, "/tmp/unknown-agent-loop-conformance", diagnostics);
  assert.equal(diagnostics.filter((item) => item.severity === "fatal").length, 0, JSON.stringify(diagnostics));

  const session = createAgentSession({
    sessionId: "unknown-agent-loop-mismatch-session",
    config: runtimeConfig(),
    transcript: new InMemoryTranscriptWriter(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopBindingFactory(modules!.agentLoop!),
  });

  const events = await collect(session.submit({ type: "text", text: "must reject" }, {
    turnId: "unknown-agent-loop-mismatch-turn",
    execution: { runId: "unknown-agent-loop-mismatch-run", operationId: "unknown-agent-loop-mismatch-operation" },
  }));
  const completed = events.find((event) => event.type === "turn_completed") as {
    result?: { type?: string; errors?: Array<{ message?: string }> };
  } | undefined;
  assert.equal(completed?.result?.type, "error", JSON.stringify(events));
  assert.match(completed?.result?.errors?.[0]?.message ?? "", /does not match configured implementation/);
});

test("unknown AgentLoop capability without streaming execute is rejected before execute", async (t) => {
  const sidecar = createUnknownLoopSidecar("unknown.agent-loop", {
    capabilities: {
      capabilitiesVersion: "1",
      methods: [{ name: "execute", enabled: true, profiles: ["unary"] }],
    },
  });
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());

  const modules = parseModulesConfig({
    agentLoop: {
      enabled: true,
      implementationId: "unknown.agent-loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-tcp-v2",
      host: address.host,
      port: address.port,
      methods: ["execute"],
    },
  }, "/tmp/unknown-agent-loop-conformance", []);
  assert.ok(modules?.agentLoop && isExternalAgentLoopBinding(modules.agentLoop));

  const session = createAgentSession({
    sessionId: "unknown-agent-loop-capability-session",
    config: runtimeConfig(),
    transcript: new InMemoryTranscriptWriter(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopBindingFactory(modules!.agentLoop!),
  });
  const events = await collect(session.submit({ type: "text", text: "must reject unary" }, { turnId: "capability-turn" }));
  const completed = events.find((event) => event.type === "turn_completed") as {
    result?: { type?: string; errors?: Array<{ message?: string }> };
  } | undefined;
  assert.equal(completed?.result?.type, "error", JSON.stringify(events));
  assert.match(completed?.result?.errors?.[0]?.message ?? "", /streaming execute capability/);
});

test("unknown AgentLoop structured execution failure remains an error", async (t) => {
  const sidecar = createUnknownLoopSidecar("unknown.agent-loop", { failure: true });
  const address = await sidecar.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => sidecar.close());
  const modules = parseModulesConfig({
    agentLoop: {
      enabled: true,
      implementationId: "unknown.agent-loop",
      contract: "pilotdeck.agent-loop/v1",
      transport: "module-tcp-v2",
      host: address.host,
      port: address.port,
      methods: ["execute"],
    },
  }, "/tmp/unknown-agent-loop-conformance", []);
  assert.ok(modules?.agentLoop && isExternalAgentLoopBinding(modules.agentLoop));

  const session = createAgentSession({
    sessionId: "unknown-agent-loop-failure-session",
    config: runtimeConfig(),
    transcript: new InMemoryTranscriptWriter(),
    dependencies: {
      router: {} as never,
      ports: { model: noopModel(), tools: noopTools() },
      tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
    },
    agentLoopFactory: createAgentLoopBindingFactory(modules!.agentLoop!),
  });
  const events = await collect(session.submit({ type: "text", text: "return structured error" }, { turnId: "failure-turn" }));
  const completed = events.find((event) => event.type === "turn_completed") as {
    result?: { type?: string; errors?: Array<{ code?: string; message?: string }> };
  } | undefined;
  assert.equal(completed?.result?.type, "error", JSON.stringify(events));
  assert.equal(completed?.result?.errors?.[0]?.code, "agent_model_error");
});

function createUnknownLoopSidecar(moduleId: string, options: { capabilities?: ModuleCapabilities; failure?: boolean } = {}): AgentLoopSidecarTcpServer {
  const server = new AgentLoopSidecarServer(({ request }) => {
    const implementation: AgentLoop = {
      async *run(input): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        if (options.failure) {
          return {
            result: {
              type: "error",
              sessionId: input.sessionId,
              turnId: input.turnId,
              stopReason: "model_error",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-19T00:00:00.000Z",
              completedAt: "2026-09-19T00:00:00.001Z",
              errors: [{ code: "agent_model_error", message: "unknown implementation failed" }],
            },
            messages: [],
          };
        }
        yield {
          type: "warning",
          sessionId: input.sessionId,
          turnId: input.turnId,
          code: "UNKNOWN_IMPLEMENTATION",
          message: "unknown implementation executed",
        };
        return {
          result: {
            type: "success",
            sessionId: input.sessionId,
            turnId: input.turnId,
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-09-19T00:00:00.000Z",
            completedAt: "2026-09-19T00:00:00.001Z",
          },
          messages: [],
        };
      },
    } as AgentLoop;
    return {
      loop: implementation,
      input: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        messages: [],
        execution: {
          runId: request.runId,
          operationId: request.operationId,
        },
      } as never,
    };
  }, { moduleId, ...(options.capabilities ? { capabilities: options.capabilities } : {}) });
  return new AgentLoopSidecarTcpServer(server);
}

function runtimeConfig(): AgentRuntimeConfig {
  return {
    provider: "test-provider",
    model: "test-model",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/tmp", mode: "default", canPrompt: false }),
  };
}

function noopModel(): ModelInvokerPort {
  return {
    async prepare({ request }) { return { request, provider: request.provider, model: request.model }; },
    async *stream() {},
  };
}

function noopTools(): ToolPort {
  return { list: () => [], executeAll: async () => [] };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of values) output.push(value);
  return output;
}
