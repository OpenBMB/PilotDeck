import test from "node:test";
import assert from "node:assert/strict";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDependencies } from "../../../src/agent/index.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/index.js";

test("AgentLoop seals assistant tool calls with synthetic results when aborted before tool execution", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "write_file",
    description: "Write a file.",
    kind: "filesystem",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
  });

  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/tmp" }),
  };

  const dependencies: AgentRuntimeDependencies = {
    router: {
      stream: async function* () {},
      decide: async () => ({
        provider: "test",
        model: "test-model",
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      }),
      execute: async function* (): AsyncGenerator<CanonicalModelEvent> {
        yield { type: "message_start", role: "assistant" };
        yield {
          type: "tool_call_end",
          toolCall: {
            id: "call_needs_permission",
            name: "write_file",
            input: { file_path: "/tmp/out.txt", content: "x" },
          },
        };
        yield { type: "message_end", finishReason: "tool_call" };
      },
    },
    tools: {
      registry,
      scheduler: {
        executeAll: async () => {
          throw new Error("tool scheduler should not run after abort");
        },
      },
    },
  };

  const controller = new AbortController();
  const durableMessages: CanonicalMessage[] = [];
  const loop = new AgentLoop(config, dependencies);
  const iterator = loop.run({
    sessionId: "s",
    turnId: "t",
    messages: [{ role: "user", content: [{ type: "text", text: "please write" }] }],
    abortSignal: controller.signal,
    onDurableMessage: (message) => {
      durableMessages.push(message);
    },
  });

  let step = await iterator.next();
  while (!step.done) {
    if (step.value.type === "tool_calls_detected") {
      controller.abort("new user message");
    }
    step = await iterator.next();
  }

  const toolResultMessage = step.value.messages.find((message) =>
    message.role === "user" && message.content.some((block) => block.type === "tool_result"),
  );
  const toolResult = toolResultMessage?.content.find((block) => block.type === "tool_result");

  assert.equal(step.value.result.type, "aborted");
  assert.equal(toolResult?.type, "tool_result");
  assert.equal(toolResult.toolCallId, "call_needs_permission");
  assert.equal(
    durableMessages.some((message) =>
      message.role === "user" && message.content.some((block) => block.type === "tool_result"),
    ),
    true,
  );
});
