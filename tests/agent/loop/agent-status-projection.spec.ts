import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { createSidecarAgentTurnCapabilities } from "../../../src/agent/loop/AgentTurnCapabilities.js";

const config = {
  provider: "test-provider",
  model: "test-model",
  cwd: "/workspace",
  permissionMode: "bypassPermissions" as const,
  permissionContext: {
    mode: "bypassPermissions" as const,
    cwd: "/workspace",
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: true,
    rules: { allow: [], deny: [], ask: [] },
  },
};

test("native and sidecar compositions preserve the B0 agent-status event shape", async () => {
  const native = AgentLoop.fromDependencies(config, {
    router: {} as never,
    tools: { registry: { list: () => [] } as never, scheduler: { executeAll: async () => [] } as never },
  });
  const sidecar = new AgentLoop(config, createSidecarAgentTurnCapabilities(config, {
    ports: {
      model: {} as never,
      toolExecution: { list: () => [], executeAll: async () => [] } as never,
    },
  }));

  const nativeStatus = await abortedStatus(native);
  const sidecarStatus = await abortedStatus(sidecar);

  assert.equal(nativeStatus.kind, undefined);
  assert.equal(nativeStatus.text, undefined);
  assert.equal(sidecarStatus.kind, undefined);
  assert.equal(sidecarStatus.text, undefined);
  assert.deepEqual(sidecarStatus, nativeStatus);
});

async function abortedStatus(loop: AgentLoop): Promise<Extract<Awaited<ReturnType<typeof collectEvents>>[number], { type: "agent_status" }>> {
  const abort = new AbortController();
  abort.abort();
  const events = await collectEvents(loop, abort.signal);
  const status = events.find((event): event is Extract<typeof event, { type: "agent_status" }> => event.type === "agent_status");
  assert.ok(status);
  return status;
}

async function collectEvents(loop: AgentLoop, abortSignal: AbortSignal) {
  const events = [] as import("../../../src/agent/protocol/events.js").AgentEvent[];
  for await (const event of loop.run({
    sessionId: "status-session",
    turnId: "status-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    abortSignal,
  })) {
    events.push(event);
  }
  return events;
}
