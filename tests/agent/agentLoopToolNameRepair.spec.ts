import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelRequest, CanonicalToolCall } from "../../src/model/index.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";
import { ToolRegistry, type PilotDeckToolDefinition, type PilotDeckToolResult } from "../../src/tool/index.js";

function createReadFileTool(): PilotDeckToolDefinition {
  return {
    name: "read_file",
    description: "Read a file.",
    kind: "filesystem",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function createConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    permissionMode: "default",
    permissionContext: {
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      mode: "default",
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createDecision(request: CanonicalModelRequest): RouterDecision {
  return {
    provider: request.provider,
    model: request.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  };
}

test("text-fallback tool name repair updates durable assistant message before execution", async () => {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  const durableMessages: CanonicalMessage[] = [];
  let executedToolName: string | undefined;

  const dependencies: AgentRuntimeDependencies = {
    router: {
      decide: async (input) => createDecision(input.request),
      execute: async function* () {
        yield { type: "message_start", role: "assistant" as const };
        yield {
          type: "text_delta",
          text: "<function=READ_FILE>\n<parameter=path>/tmp/a.txt</parameter>\n</function>",
        };
        yield { type: "message_end", finishReason: "stop" as const };
      },
      stream: async function* () {},
    },
    tools: {
      registry,
      scheduler: {
        executeAll: async (calls: CanonicalToolCall[]): Promise<PilotDeckToolResult[]> => {
          executedToolName = calls[0]?.name;
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "ok" }],
            startedAt: new Date(0).toISOString(),
            completedAt: new Date(0).toISOString(),
          }));
        },
      },
    },
    now: () => new Date(0),
  };

  const loop = new AgentLoop(createConfig(), dependencies);
  const input: AgentLoopInput = {
    sessionId: "s",
    turnId: "t",
    maxTurns: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "read it" }] }],
    onDurableMessage: (message) => {
      durableMessages.push(message);
    },
  };

  for await (const _event of loop.run(input)) {
    // consume stream
  }

  const assistant = durableMessages.find((message) => message.role === "assistant");
  const toolCall = assistant?.content.find((block) => block.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  assert.equal(toolCall?.name, "read_file");
  assert.equal(executedToolName, "read_file");
});
