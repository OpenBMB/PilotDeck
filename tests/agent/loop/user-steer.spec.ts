import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentSteerMessage } from "../../../src/agent/session/SteerMailbox.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";

test("guidance at the terminal boundary becomes a user message and starts another model loop", async () => {
  const requests: CanonicalModelRequest[] = [];
  let responseNumber = 0;
  const respond = async function* (request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    requests.push(request);
    responseNumber += 1;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: responseNumber === 1 ? "first answer" : "revised answer" };
    yield { type: "message_end", finishReason: "stop" };
  };
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: (_decision, request) => respond(request),
    stream: (request) => respond(request),
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  };
  const steerMessage: AgentSteerMessage = {
    itemId: "queue-1",
    message: {
      role: "user",
      content: [{ type: "text", text: "Use HTML instead" }],
      metadata: { purpose: "mid_turn_steer", queueItemId: "queue-1" },
    },
  };
  let terminalBoundaryCount = 0;
  const durable: CanonicalMessage[] = [];
  const eventTypes: string[] = [];
  const loop = new AgentLoop(config, dependencies);

  const iterator = loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Build a game" }] }],
    drainSteerMessages: () => [],
    drainOrCloseSteerMailbox: () => {
      terminalBoundaryCount += 1;
      return terminalBoundaryCount === 1
        ? { messages: [steerMessage], closed: false }
        : { messages: [], closed: true };
    },
    onDurableMessage: (message) => {
      durable.push(message);
    },
  });
  let finalMessages: CanonicalMessage[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      finalMessages = next.value.messages;
      break;
    }
    eventTypes.push(next.value.type);
  }

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(requests[1]?.messages.at(-1)?.metadata?.queueItemId, "queue-1");
  assert.equal(finalMessages.at(-2)?.metadata?.queueItemId, "queue-1");
  assert.equal(finalMessages.at(-1)?.role, "assistant");
  assert.ok(eventTypes.includes("steer_applied"));
  assert.ok(eventTypes.includes("turn_continued"));
  assert.ok(durable.some((message) => message.metadata?.queueItemId === "queue-1"));
});

test("terminal guidance does not bypass the configured max turn budget", async () => {
  let requestCount = 0;
  const respond = async function* (): AsyncIterable<CanonicalModelEvent> {
    requestCount += 1;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "answer" };
    yield { type: "message_end", finishReason: "stop" };
  };
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: (_decision, _request) => respond(),
    stream: (_request) => respond(),
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
  const loop = new AgentLoop({
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
  }, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  });
  let terminalDrainCount = 0;

  for await (const _event of loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Build a game" }] }],
    maxTurns: 1,
    drainOrCloseSteerMailbox: () => {
      terminalDrainCount += 1;
      return {
        closed: false,
        messages: [{
          itemId: "queue-1",
          message: { role: "user", content: [{ type: "text", text: "Revise it" }] },
        }],
      };
    },
  })) {
    // Exhaust the turn.
  }

  assert.equal(requestCount, 1);
  assert.equal(terminalDrainCount, 0);
});

test("failed steer persistence does not apply its message or file permissions", async () => {
  const loop = new AgentLoop({
    provider: "openai",
    model: "test-model",
    cwd: "/workspace/project",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
  }, {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
    } as unknown as AgentRouterRuntime,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  });
  const applied: string[] = [];
  const events: string[] = [];
  let drained = false;

  await assert.rejects(async () => {
    for await (const event of loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "Build a game" }] }],
      drainSteerMessages: () => {
        if (drained) return [];
        drained = true;
        return [
          {
            itemId: "queue-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "Use the first file" }],
              metadata: { queueItemId: "queue-1" },
            },
            allowedReadFiles: ["/workspace/project/first.txt"],
          },
          {
            itemId: "queue-2",
            message: {
              role: "user",
              content: [{ type: "text", text: "Use the second file" }],
              metadata: { queueItemId: "queue-2" },
            },
            allowedReadFiles: ["/workspace/project/second.txt"],
          },
        ];
      },
      onDurableMessage: (message) => {
        if (message.metadata?.queueItemId === "queue-2") {
          throw new Error("transcript unavailable");
        }
      },
      onSteerApplied: (itemId) => applied.push(itemId),
    })) {
      events.push(event.type);
    }
  }, /transcript unavailable/);

  assert.deepEqual(applied, ["queue-1"]);
  assert.deepEqual(events.filter((type) => type === "steer_applied"), ["steer_applied"]);
  assert.deepEqual(loop.snapshotFileState().allowedReadFiles, ["/workspace/project/first.txt"]);
});
