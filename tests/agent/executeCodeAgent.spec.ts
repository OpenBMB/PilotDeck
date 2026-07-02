import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession } from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentRouterRuntime } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import { contentToText } from "../../src/tool/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { RouterDecision } from "../../src/router/index.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

function createExecuteCodeRouter(): AgentRouterRuntime {
  let executeCount = 0;
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    } satisfies RouterDecision),
    execute: async function* (_decision: RouterDecision, _request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      executeCount += 1;
      yield { type: "message_start", role: "assistant" };
      if (executeCount === 1) {
        const toolCall = {
          id: "agent-execute-code-call",
          name: "execute_code",
          input: { code: 'print("agent execute_code ok")' },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
}

test("agent loop can execute the execute_code tool", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-agent-execute-code-"));
  try {
    const registry = createBuiltinRegistry({ webSearch: false, webFetch: false, agent: false, askUserQuestion: false });
    const session = createAgentSession({
      sessionId: "agent-execute-code-session",
      config: {
        provider: "test",
        model: "fake-model",
        cwd,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
      },
      dependencies: {
        router: createExecuteCodeRouter(),
        tools: { registry },
        now: () => new Date("2026-07-02T00:00:00.000Z"),
        uuid: (() => {
          let id = 0;
          return () => `test-id-${++id}`;
        })(),
      },
    });

    const events: AgentEvent[] = [];
    for await (const event of session.submit({ type: "text", text: "run execute_code" }, { maxTurns: 3 })) {
      events.push(event);
    }

    const toolResult = events.find((event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.result.toolName === "execute_code");
    assert.ok(toolResult, "expected execute_code tool_result event");
    assert.equal(toolResult.result.type, "success");
    assert.match(toolResult.result.content.map(contentToText).join("\n"), /agent execute_code ok/);
    assert.ok(events.some((event) => event.type === "tool_calls_detected" && event.calls.some((call) => call.name === "execute_code")));
    assert.ok(events.some((event) => event.type === "turn_completed" && event.result.type === "success"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
