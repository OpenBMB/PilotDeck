import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { ConcurrentToolScheduler, ToolRegistry, ToolRuntime } from "../../../src/tool/index.js";

for (const failure of [undefined, null, false, 0, "", new Error("Synthetic permission failure")]) {
  test(`tool failure survives scheduling, event delivery and pairing (${String(failure)})`, async (t) => {
    const registry = new ToolRegistry();
    registry.register({ name: "probe", description: "Synthetic probe", kind: "custom", inputSchema: { type: "object" },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      execute: async () => { assert.fail("Failed permission checks cannot execute tools"); } });
    const permission = new PermissionRuntime();
    t.mock.method(permission, "decide", async () => { throw failure; });
    const buffer: AgentEvent[] = [];
    const runtime = new ToolRuntime(registry, permission, undefined, (event) => { buffer.push(event); });
    const requests: CanonicalModelRequest[] = [];
    const router: AgentRouterRuntime = {
      decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default",
        isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
      execute: async function* (_decision, request) {
        requests.push(request);
        yield { type: "message_start", role: "assistant" };
        if (requests.length === 1) {
          for (const id of ["one", "two"]) {
            yield { type: "tool_call_start", id, name: "probe" };
            yield { type: "tool_call_end", toolCall: { id, name: "probe", input: {} } };
          }
          yield { type: "message_end", finishReason: "tool_call" };
        } else {
          yield { type: "text_delta", text: "The probes failed." };
          yield { type: "message_end", finishReason: "stop" };
        }
      },
      stream: async function* () { assert.fail("Use routed execution in this fixture"); },
    };
    const loop = new AgentLoop({ provider: "test", model: "test-model", cwd: process.cwd(), permissionMode: "default",
      permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), canPrompt: false }) }, {
      router, tools: { registry, scheduler: new ConcurrentToolScheduler(runtime, registry) }, drainEvents: () => buffer.splice(0),
    });
    const events: AgentEvent[] = [];
    for await (const event of loop.run({ sessionId: "failure-session", turnId: "failure-turn", maxTurns: 2,
      messages: [{ role: "user", content: [{ type: "text", text: "Run both probes" }] }] })) events.push(event);
    assert.equal(requests.length, 2);
    const results = events.filter((event) => event.type === "tool_result").map((event) => event.result);
    assert.deepEqual(results.map((result) => result.toolCallId), ["one", "two"]);
    for (const result of results) {
      if (result.type !== "error") assert.fail("Expected a paired tool error");
      assert.equal(result.error.code, "tool_execution_failed");
      assert.equal(result.error.message, failure instanceof Error ? failure.message : String(failure));
    }
    const projected = requests[1].messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result");
    assert.deepEqual(projected.map((block) => block.toolCallId), ["one", "two"]);
    assert.ok(projected.every((block) => block.isError));
    const preEvents = events.filter((event) => event.type === "pre_tool_execute");
    assert.equal(preEvents.length, 2);
    assert.ok(events.indexOf(preEvents[1]) < events.findIndex((event) => event.type === "tool_result"));
  });
}
