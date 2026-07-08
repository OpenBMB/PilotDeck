import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";
import { ToolRegistry } from "../../src/tool/index.js";

function createConfig(): AgentRuntimeConfig {
  return {
    provider: "openai",
    model: "gpt-test",
    cwd: "/tmp/pilotdeck-status-test",
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/tmp/pilotdeck-status-test",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
    },
  };
}

function createDependencies(): AgentRuntimeDependencies {
  return {
    router: {
      async decide() {
        return { provider: "openai", model: "gpt-test" } as never;
      },
      async *execute(): AsyncIterable<CanonicalModelEvent> {
        yield {
          type: "error",
          error: {
            provider: "openai",
            protocol: "openai",
            code: "auth_error",
            status: 401,
            message: "Invalid API key.",
            retryable: false,
            raw: { secret: "do-not-surface" },
            userHint: "Check the provider API key.",
          },
        };
      },
      async *stream(): AsyncIterable<CanonicalModelEvent> {},
    },
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    now: () => new Date("2026-07-07T00:00:00.000Z"),
  };
}

test("AgentLoop emits semantic model_request_failed status before turn_failed", async () => {
  const loop = new AgentLoop(createConfig(), createDependencies());
  const events: AgentEvent[] = [];
  const recordedStatuses: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const generator = loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    onAgentStatusMessage: (status) => {
      recordedStatuses.push({ event: status.event, detail: status.detail });
    },
  });

  while (true) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
  }

  const statusIndex = events.findIndex((event) =>
    event.type === "agent_status" && event.event === "model_request_failed"
  );
  const turnFailedIndex = events.findIndex((event) => event.type === "turn_failed");
  assert.notEqual(statusIndex, -1);
  assert.notEqual(turnFailedIndex, -1);
  assert.ok(statusIndex < turnFailedIndex);
  assert.equal(recordedStatuses[0]?.event, "model_request_failed");
  assert.equal(recordedStatuses[0]?.detail?.message, "Invalid API key.");
  assert.equal(recordedStatuses[0]?.detail?.code, "agent_model_error");
  assert.equal(recordedStatuses[0]?.detail?.provider, "openai");
  assert.equal(recordedStatuses[0]?.detail?.status, 401);
  assert.equal(recordedStatuses[0]?.detail?.modelErrorCode, "auth_error");
  assert.equal(recordedStatuses[0]?.detail?.retryable, false);
  assert.equal(recordedStatuses[0]?.detail?.scope, "turn");
  assert.equal(recordedStatuses[0]?.detail?.source, "agent");
  assert.equal(recordedStatuses[0]?.detail?.raw, undefined);
});

test("AgentLoop emits lifecycle_blocked status when a stop hook blocks", async () => {
  const dependencies = createDependencies();
  dependencies.router = {
    async decide() {
      return { provider: "openai", model: "gpt-test" } as never;
    },
    async *execute(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {},
  };
  dependencies.lifecycle = {
    async dispatch(input: { event: string }) {
      if (input.event !== "Stop") {
        return {
          effects: [],
          messages: [],
          events: [],
          blockingErrors: [],
          nonBlockingErrors: [],
        };
      }
      return {
        effects: [{ type: "block", reason: "blocked by hook" }],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    },
  } as never;
  const loop = new AgentLoop(createConfig(), dependencies);
  const events: AgentEvent[] = [];
  const recordedStatuses: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const generator = loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    onAgentStatusMessage: (status) => {
      recordedStatuses.push({ event: status.event, detail: status.detail });
    },
  });

  while (true) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
  }

  const statusIndex = events.findIndex((event) =>
    event.type === "agent_status" && event.event === "lifecycle_blocked"
  );
  const turnFailedIndex = events.findIndex((event) => event.type === "turn_failed");
  assert.notEqual(statusIndex, -1);
  assert.notEqual(turnFailedIndex, -1);
  assert.ok(statusIndex < turnFailedIndex);
  assert.equal(recordedStatuses[0]?.event, "lifecycle_blocked");
  assert.equal(recordedStatuses[0]?.detail?.message, "blocked by hook");
  assert.equal(recordedStatuses[0]?.detail?.stage, "stop");
  assert.equal(recordedStatuses[0]?.detail?.scope, "turn");
  assert.equal(recordedStatuses[0]?.detail?.source, "agent");
});

test("AgentLoop emits tool_error_loop status for repeated invalid tool calls", async () => {
  const dependencies = createDependencies();
  let callIndex = 0;
  dependencies.router = {
    async decide() {
      return { provider: "openai", model: "gpt-test" } as never;
    },
    async *execute(): AsyncIterable<CanonicalModelEvent> {
      const id = `tool-${++callIndex}`;
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id, name: "bad_tool" };
      yield { type: "tool_call_end", toolCall: { id, name: "bad_tool", input: { bad: true } } };
      yield { type: "message_end", finishReason: "tool_call" };
    },
    async *stream(): AsyncIterable<CanonicalModelEvent> {},
  };
  dependencies.tools.scheduler = {
    async executeAll(calls) {
      return calls.map((call) => ({
        type: "error" as const,
        toolCallId: call.id,
        toolName: call.name,
        error: { code: "invalid_tool_input" as const, message: "bad input" },
        content: [{ type: "text" as const, text: "bad input" }],
        startedAt: "2026-07-07T00:00:00.000Z",
        completedAt: "2026-07-07T00:00:00.000Z",
      }));
    },
  };
  const loop = new AgentLoop(createConfig(), dependencies);
  const events: AgentEvent[] = [];
  const recordedStatuses: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const generator = loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    maxTurns: 10,
    messages: [{ role: "user", content: [{ type: "text", text: "call bad tool" }] }],
    onAgentStatusMessage: (status) => {
      recordedStatuses.push({ event: status.event, detail: status.detail });
    },
  });

  while (true) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
  }

  const statusIndex = events.findIndex((event) =>
    event.type === "agent_status" && event.event === "tool_error_loop"
  );
  const turnFailedIndex = events.findIndex((event) => event.type === "turn_failed");
  assert.notEqual(statusIndex, -1);
  assert.notEqual(turnFailedIndex, -1);
  assert.ok(statusIndex < turnFailedIndex);
  assert.equal(recordedStatuses.at(-1)?.event, "tool_error_loop");
  assert.equal(recordedStatuses.at(-1)?.detail?.code, "agent_tool_error_loop");
  assert.equal(recordedStatuses.at(-1)?.detail?.repeatedFailures, 4);
  assert.equal(recordedStatuses.at(-1)?.detail?.scope, "turn");
  assert.equal(recordedStatuses.at(-1)?.detail?.source, "agent");
});
