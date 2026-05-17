import test from "node:test";
import assert from "node:assert/strict";
import { createPilotDeckTestTool } from "../helpers/tool.js";
import { collectAsyncGenerator, createAgentLoopFixture } from "../helpers/agent.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

/**
 * Tests for the consecutive tool-validation-error circuit breaker in AgentLoop.
 *
 * When a model is stuck emitting invalid tool calls (e.g. qwen3.6 repeatedly
 * calling bash with empty parameters), the loop should terminate after
 * MAX_CONSECUTIVE_ALL_INVALID_TURNS (3) turns instead of spinning forever.
 */

function makeToolCallTurn(toolName: string, input: Record<string, unknown>): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    { type: "tool_call_end", toolCall: { id: `call-${Math.random().toString(36).slice(2, 8)}`, name: toolName, input } },
    { type: "message_end", finishReason: "tool_call" },
  ];
}

function makeTextTurn(text: string): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text },
    { type: "message_end", finishReason: "stop" },
  ];
}

test("AgentLoop circuit breaker triggers after 3 consecutive all-invalid turns", async () => {
  const tool = createPilotDeckTestTool({
    name: "bash",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: { command: { type: "string" } },
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });

  // Script: 3 turns of invalid tool calls (missing `command`), then a text turn
  // that should never be reached.
  const scripts: CanonicalModelEvent[][] = [
    makeToolCallTurn("bash", {}),
    makeToolCallTurn("bash", {}),
    makeToolCallTurn("bash", {}),
    makeTextTurn("This should not be reached"),
  ];

  const { loop, model } = createAgentLoopFixture({ tools: [tool], scripts });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s1",
      turnId: "t1",
      messages: [{ role: "user", content: [{ type: "text", text: "do something" }] }],
    }),
  );

  assert.equal(result.result.type, "error", "should terminate with error");
  assert.ok(
    result.result.errors?.some((e) => e.code === "agent_tool_error_loop"),
    "should have agent_tool_error_loop error code",
  );
  // Only 3 model requests (the 4th script is never reached).
  assert.equal(model.requests.length, 3, "should stop after 3 turns, not continue");
});

test("AgentLoop circuit breaker resets on a successful tool call", async () => {
  const tool = createPilotDeckTestTool({
    name: "bash",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: { command: { type: "string" } },
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });

  // 2 invalid turns, then 1 valid turn (resets counter), then 2 more invalid,
  // then a text turn (completes). Should NOT trigger circuit breaker.
  const scripts: CanonicalModelEvent[][] = [
    makeToolCallTurn("bash", {}),         // invalid #1
    makeToolCallTurn("bash", {}),         // invalid #2
    makeToolCallTurn("bash", { command: "echo hi" }), // valid → resets counter
    makeToolCallTurn("bash", {}),         // invalid #1 (new streak)
    makeToolCallTurn("bash", {}),         // invalid #2
    makeTextTurn("Done"),                 // completes
  ];

  const { loop, model } = createAgentLoopFixture({ tools: [tool], scripts });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s2",
      turnId: "t2",
      messages: [{ role: "user", content: [{ type: "text", text: "do something" }] }],
    }),
  );

  assert.equal(result.result.type, "success", "should complete successfully");
  assert.equal(model.requests.length, 6, "all 6 scripts should be consumed");
});

test("AgentLoop circuit breaker does not trigger on mixed error types", async () => {
  const tool = createPilotDeckTestTool({
    name: "bash",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: { command: { type: "string" } },
    },
    execute: async () => {
      throw new Error("exec fail");
    },
  });

  // 3 turns of valid-input tool calls that fail at EXECUTION (not validation).
  // Circuit breaker should NOT trigger because error code is `tool_execution_failed`,
  // not `invalid_tool_input`.
  const scripts: CanonicalModelEvent[][] = [
    makeToolCallTurn("bash", { command: "bad1" }),
    makeToolCallTurn("bash", { command: "bad2" }),
    makeToolCallTurn("bash", { command: "bad3" }),
    makeTextTurn("Done"),
  ];

  const { loop, model } = createAgentLoopFixture({ tools: [tool], scripts });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "s3",
      turnId: "t3",
      messages: [{ role: "user", content: [{ type: "text", text: "do something" }] }],
    }),
  );

  assert.equal(result.result.type, "success", "should complete successfully");
  assert.equal(model.requests.length, 4, "all 4 scripts should be consumed");
});
