import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { ConcurrentToolScheduler, ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";

for (const failure of [undefined, null, false, 0, "", new Error("permission backend unavailable")]) {
  test(`tool scheduler rejection preserves its reason through the agent event pump (${String(failure)})`, async (t) => {
    const registry = new ToolRegistry();
    registry.register({
      name: "probe", description: "Synthetic failure fixture", kind: "custom", inputSchema: { type: "object" },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      execute: async () => { assert.fail("A failed permission check must not execute the tool"); },
    });
    const permission = new PermissionRuntime();
    t.mock.method(permission, "decide", async () => { throw failure; });
    const buffered: AgentEvent[] = [];
    const runtime = new ToolRuntime(registry, permission, undefined, (event) => { buffered.push(event); });
    const requests: CanonicalModelRequest[] = [];
    const router: AgentRouterRuntime = {
      invalidateSticky: () => ({ orchestrating: false }),
      decide: async ({ request }) => ({
        provider: request.provider, model: request.model, scenarioType: "default", isSubagent: false,
        orchestrating: false, resolvedFrom: "explicit", mutations: {},
      }),
      execute: async function* (_decision, request) {
        requests.push(request);
        yield { type: "message_start", role: "assistant" };
        if (requests.length === 1) {
          for (const id of ["probe-1", "probe-2"]) {
            yield { type: "tool_call_start", id, name: "probe" };
            yield { type: "tool_call_end", toolCall: { id, name: "probe", input: {} } };
          }
          yield { type: "message_end", finishReason: "tool_call" };
        } else {
          yield { type: "text_delta", text: "Permission backend failed." };
          yield { type: "message_end", finishReason: "stop" };
        }
      },
      stream: async function* () { assert.fail("This fixture uses routed execution"); },
      materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
      observeUsage: () => undefined,
    };
    const loop = new AgentLoop({
      provider: "test", model: "test-model", cwd: process.cwd(), permissionMode: "default",
      permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), mode: "default", canPrompt: false }),
    }, {
      router, tools: { registry, scheduler: new ConcurrentToolScheduler(runtime, registry) },
      drainEvents: () => buffered.splice(0),
    });
    const events: AgentEvent[] = [];
    for await (const event of loop.run({
      sessionId: "scheduler-failure-session", turnId: "scheduler-failure-turn", maxTurns: 2,
      messages: [{ role: "user", content: [{ type: "text", text: "Run both probes." }] }],
    })) events.push(event);

    assert.equal(requests.length, 2);
    const results = events.filter((event) => event.type === "tool_result").map((event) => event.result);
    assert.deepEqual(results.map((result) => result.toolCallId), ["probe-1", "probe-2"]);
    for (const result of results) {
      assert.equal(result.type, "error");
      if (result.type !== "error") assert.fail("Expected a paired failure result");
      assert.equal(result.error.code, "tool_execution_failed");
      assert.equal(result.error.message, failure instanceof Error ? failure.message : String(failure));
    }
    const projected = requests[1].messages.flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    assert.deepEqual(projected.map((block) => block.toolCallId), ["probe-1", "probe-2"]);
    assert.ok(projected.every((block) => block.isError));
    const preEvents = events.filter((event) => event.type === "pre_tool_execute");
    assert.equal(preEvents.length, 2);
    assert.ok(events.indexOf(preEvents[1]) < events.findIndex((event) => event.type === "tool_result"));
  });
}
