import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRouterRuntime, AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest, CanonicalToolCall } from "../../../src/model/protocol/canonical.js";
import { createOpenAIStreamState, normalizeOpenAIStreamEvent } from "../../../src/model/providers/openai/stream.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../../src/gateway/client/InProcessGateway.js";
import { flattenCanonicalMessage } from "../../../src/web/server/readSessionMessages.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

test("output-limit continuation preserves distinct block identities through live and durable history", async () => {
  let requests = 0;
  const durable: CanonicalMessage[] = [];
  const events: AgentEvent[] = [];
  const loop = createLoop(async function* () {
    requests++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "thinking_delta", text: "Same reasoning" };
    yield { type: "text_delta", text: "Same answer" };
    yield { type: "message_end", finishReason: requests === 1 ? "length" : "stop" };
  }, () => undefined);
  for await (const event of loop.run({
    sessionId: "output-continuation", turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    onDurableMessage: async message => { durable.push(JSON.parse(JSON.stringify(message))); },
  })) events.push(event);

  assert.equal(requests, 2);
  const live = events.flatMap(event => mapAgentEvent(event, "turn-1"))
    .filter(event => event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta");
  const history = durable.flatMap((message, index) => flattenCanonicalMessage(message, { sessionKey: "output-continuation", index }));
  assert.equal(live.length, 4);
  assert.equal(new Set(live.map(event => event.blockId)).size, 4);
  assert.ok(live.every(event => typeof event.blockId === "string"));
  assert.deepEqual(history.map(message => message.blockId), live.map(event => event.blockId));
  assert.deepEqual(history.map(message => message.text), ["Same reasoning", "Same answer", "Same reasoning", "Same answer"]);
});

for (const completeFirst of [false, true]) test(`agent loop drops interrupted response tools (complete first call: ${completeFirst})`, async () => {
  const requests: CanonicalModelRequest[] = [];
  let scheduledToolCalls = 0;
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      if (completeFirst) {
        yield { type: "tool_call_start", id: "complete-but-discarded", name: "write_file" };
        yield { type: "tool_call_end", toolCall: { id: "complete-but-discarded", name: "write_file", input: { path: "unused", content: "unused" } } };
      }

      yield { type: "tool_call_start", id: "call-1", name: "write_file" };
      yield { type: "tool_call_delta", id: "call-1", delta: '{"path":"deck.mjs","content":"partial"' };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: {
            phase: "tool_call",
            activeToolCalls: [{ id: "call-1", name: "write_file", argumentChars: 39 }],
          },
        },
      };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => { scheduledToolCalls += 1; });

  const events: AgentEvent[] = [];
  for await (const event of loop.run({
    sessionId: "stream-interruption",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a deck builder" }] }],
  })) {
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.equal(scheduledToolCalls, 0);
  const recoveredDelta = events.find(event => event.type === "model_event" && event.event.type === "text_delta");
  assert.ok(recoveredDelta?.timeline);
  assert.equal(recoveredDelta.timeline.previousId, undefined, "a discarded response tool must not leave a predecessor dependency");

  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.ok(!events.some((event) => event.type === "turn_failed"));
  const recoveryRequest = requests[1]!;
  const recoveryText = recoveryRequest.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /small focused write_file or edit_file calls/);
  assert.doesNotMatch(JSON.stringify(recoveryRequest.messages), /\"content\":\"partial/);
});

test("agent loop recovers an unknown finish reason before treating the turn as successful", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "partial" };
      yield { type: "message_end", finishReason: "unknown" };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "unknown-finish",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write an answer" }] }],
  })) {
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.ok(!events.some((event) => event.type === "unknown_finish_reason"));
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /without a recognized finish reason/);
});

test("unknown finish with literal tool syntax uses ordinary finish recovery", async () => {
  const requests: CanonicalModelRequest[] = [];
  let scheduledToolCalls = 0;
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"deck.mjs"';
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: partialToolText };
      yield { type: "message_end", finishReason: "unknown" };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => { scheduledToolCalls += 1; });

  for await (const _event of loop.run({
    sessionId: "unknown-partial-tool",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a deck builder" }] }],
  })) {
    // Consume the complete recovery flow.
  }

  assert.equal(requests.length, 2);
  assert.equal(scheduledToolCalls, 0);
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /without a recognized finish reason/);
  assert.doesNotMatch(recoveryText?.type === "text" ? recoveryText.text : "", /deck\.mjs|partial-secret/);
  assert.ok(requests[1]!.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === partialToolText)));
});

test("stream interruption preserves incomplete tool examples as text", async () => {
  const requests: CanonicalModelRequest[] = [];
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"';
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: partialToolText };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: { phase: "text" },
        },
      };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "interrupted-partial-tool",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    // Consume the complete recovery flow.
  }

  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === partialToolText)));
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /Continue exactly where the visible response ended/);
  assert.doesNotMatch(recoveryText?.type === "text" ? recoveryText.text : "", /deck\.mjs|partial-secret/);
});

test("cancelling stream interruption recovery preserves literal tool syntax", async () => {
  const controller = new AbortController();
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"';
  const loop = createLoop(async function* (_decision, _request, context) {
    if (context.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: partialToolText };
    yield {
      type: "error",
      error: {
        provider: "test",
        protocol: "openai",
        code: "timeout",
        message: "Stream idle timeout",
        retryable: true,
        streamInterruption: { phase: "text" },
      },
    };
  }, () => undefined);

  const events: Array<{ type: string; result?: { finalMessage?: CanonicalMessage } }> = [];
  for await (const event of loop.run({
    sessionId: "cancel-interrupted-partial-tool",
    turnId: "turn-1",
    abortSignal: controller.signal,
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    events.push(event as typeof events[number]);
    if (event.type === "turn_continued") {
      controller.abort();
    }
  }

  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.result?.finalMessage?.content.find((block) => block.type === "text")?.text, partialToolText);
});

test("incomplete tool syntax with stop completes without recovery", async () => {
  const controller = new AbortController();
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"';
  const loop = createLoop(async function* (_decision, _request, context) {
    if (context.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: partialToolText };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  const events: Array<{ type: string; result?: { finalMessage?: CanonicalMessage } }> = [];
  for await (const event of loop.run({
    sessionId: "cancel-partial-tool-recovery",
    turnId: "turn-1",
    abortSignal: controller.signal,
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    events.push(event as typeof events[number]);
    if (event.type === "turn_continued") {
      controller.abort();
    }
  }

  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.result?.finalMessage?.content.find((block) => block.type === "text")?.text, partialToolText);
  assert.equal(events.some((event) => event.type === "turn_continued"), false);
});

test("stream interruption preserves complete tool examples as text", async () => {
  const requests: CanonicalModelRequest[] = [];
  const completeToolText = 'Prefix <tool_call>{"name":"write_file","arguments":{"path":"safe.mjs","content":"secret"}}</tool_call>';
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: completeToolText };
      yield {
        type: "error",
        error: {
          provider: "test",
          protocol: "openai",
          code: "timeout",
          message: "Stream idle timeout",
          retryable: true,
          streamInterruption: { phase: "text" },
        },
      };
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "interrupted-complete-tool",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    // Consume the complete recovery flow.
  }

  assert.equal(requests.length, 2);
  assert.ok(requests[1]!.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === completeToolText)));
  const recoveryText = requests[1]!.messages.at(-1)?.content[0];
  assert.equal(recoveryText?.type, "text");
  assert.match(recoveryText?.type === "text" ? recoveryText.text : "", /Continue exactly where the visible response ended/);
  assert.doesNotMatch(recoveryText?.type === "text" ? recoveryText.text : "", /safe\.mjs|secret/);
});

test("stream interruption exhaustion persists the final safe text fragment", async () => {
  const durable: string[] = [];
  let attempt = 0;
  const loop = createLoop(async function* (_decision, request) {
    attempt++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "final-fragment-" + attempt };
    yield {
      type: "error",
      error: {
        provider: "test",
        protocol: "openai",
        code: "timeout",
        message: "Stream idle timeout",
        retryable: true,
        streamInterruption: { phase: "text" },
      },
    };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "interrupted-exhausted",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
    onDurableMessage: async (message) => {
      durable.push(message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    },
  })) {
    // Consume the complete recovery flow.
  }

  assert.ok(durable.some((text) => text.includes("final-fragment-3")));
});

test("unknown finish exhaustion persists the final safe text fragment", async () => {
  const durable: string[] = [];
  let attempt = 0;
  const loop = createLoop(async function* (_decision, request) {
    attempt++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "unknown-fragment-" + attempt };
    yield { type: "message_end", finishReason: "unknown" };
  }, () => undefined);

  for await (const _event of loop.run({
    sessionId: "unknown-exhausted",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
    onDurableMessage: async (message) => {
      durable.push(message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    },
  })) {
    // Consume the complete recovery flow.
  }

  assert.ok(durable.some((text) => text.includes("unknown-fragment-3")));
});

test("literal tool syntax without message_end does not trigger tool recovery", async () => {
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs","content":"partial-secret"';
  let attempt = 0;
  const loop = createLoop(async function* () {
    attempt++;
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: partialToolText };
  }, () => undefined);

  const events: Array<{ type: string; result?: { finalMessage?: CanonicalMessage } }> = [];
  for await (const event of loop.run({
    sessionId: "partial-tool-exhausted",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    events.push(event as typeof events[number]);
  }

  assert.equal(attempt, 1);
  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.result?.finalMessage?.content.find((block) => block.type === "text")?.text, partialToolText);
});

test("stream interruption exhaustion preserves literal tool syntax", async () => {
  const partialToolText = '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs","content":"partial-secret-3"';
  const loop = createLoop(async function* () {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: partialToolText };
    yield {
      type: "error",
      error: {
        provider: "test",
        protocol: "openai",
        code: "timeout",
        message: "Stream idle timeout",
        retryable: true,
        streamInterruption: { phase: "text" },
      },
    };
  }, () => undefined);

  const events: Array<{ type: string; result?: { finalMessage?: CanonicalMessage } }> = [];
  for await (const event of loop.run({
    sessionId: "interrupted-unsafe-final",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
  })) {
    events.push(event as typeof events[number]);
  }

  const completed = events.find((event) => event.type === "turn_completed");
  assert.equal(completed?.result?.finalMessage?.content.find((block) => block.type === "text")?.text, partialToolText);
});

const literalToolExamples = {
  think: '<think>I considered <tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call> but do not need it.</think>Answer without using tools.',
  bare: '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
  fenced: '```xml\n<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>\n```',
  inline: 'Example: `<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>`.',
  incomplete: '<think>The opening tag is <tool_call>.</think>Answer without using tools.',
  malformed: '<tool_call>{invalid json}</tool_call>',
  qwen: '<tool_call><function=read_file><parameter=path>README.md</parameter></function></tool_call>',
  deepseek: '<｜DSML｜tool_calls><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">README.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
  mistral: '[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"README.md"}}]',
  llama: '<|python_tag|>{"name":"read_file","parameters":{"path":"README.md"}}',
};

for (const [name, text] of Object.entries(literalToolExamples)) {
  for (const chunked of [false, true]) {
    test(`OpenAI ${name} text stays literal through assembler and AgentLoop (${chunked ? "character chunks" : "whole chunk"})`, async () => {
      let requests = 0;
      const scheduled: CanonicalToolCall[] = [];
      const durable: CanonicalMessage[] = [];
      const reasoning = `Native reasoning can quote examples too: ${literalToolExamples.bare}`;
      const loop = createLoop(async function* () {
        requests++;
        // Bound failures if a future regression starts retrying this example.
        assert.equal(requests, 1, "literal text must not trigger another model request");
        const state = createOpenAIStreamState();
        if (chunked) {
          yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { reasoning_content: reasoning } }] }, state);
        }
        for (const content of chunked ? [...text] : [text]) {
          yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { content } }] }, state);
        }
        yield* normalizeOpenAIStreamEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }, state);
      }, (calls) => { scheduled.push(...calls); });

      const events = [];
      for await (const event of loop.run({
        sessionId: `literal-${name}`,
        turnId: "turn-1",
        messages: [{ role: "user", content: [{ type: "text", text: "Explain special tokens and tool-call formats." }] }],
        onDurableMessage: async (message) => { durable.push(message); },
      })) events.push(event);

      assert.equal(requests, 1);
      assert.deepEqual(scheduled, []);
      assert.equal(events.some((event) => ["turn_continued", "turn_failed", "warning", "tool_result_message"].includes(event.type)), false);
      assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "success");
      assert.equal(durable.length, 1);
      const blockIds = [...new Set(events.flatMap(event =>
        event.type === "model_event" && event.blockId ? [event.blockId] : []))];
      assert.equal(blockIds.length, chunked ? 2 : 1);
      assert.ok(durable[0]!.content.every(block => block.timeline?.version === 1));
      assert.deepEqual(durable[0]!.content.map(({ timeline: _timeline, ...block }) => block), [
        ...(chunked ? [{ type: "thinking", text: reasoning, reasoningContent: reasoning, blockId: blockIds[0] }] : []),
        { type: "text", text, blockId: blockIds.at(-1) },
      ]);
    });
  }
}

test("native OpenAI tool calls still dispatch exactly once alongside literal examples", async () => {
  let requests = 0;
  const scheduled: CanonicalToolCall[] = [];
  const durable: CanonicalMessage[] = [];
  const loop = createLoop(async function* () {
    requests++;
    assert.ok(requests <= 2);
    const state = createOpenAIStreamState();
    if (requests === 1) {
      yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { content: literalToolExamples.think } }] }, state);
      yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { tool_calls: [{
        index: 0, id: "native-read", type: "function", function: { name: "read_file", arguments: '{"path":' },
      }] } }] }, state);
      yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { tool_calls: [{
        index: 0, function: { arguments: '"actual.txt"}' },
      }] }, finish_reason: "tool_calls" }] }, state);
    } else {
      yield* normalizeOpenAIStreamEvent({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }, state);
    }
  }, (calls) => { scheduled.push(...calls); });

  const events = [];
  for await (const event of loop.run({
    sessionId: "native-with-example",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Read actual.txt." }] }],
    onDurableMessage: async (message) => { durable.push(message); },
  })) events.push(event);

  assert.equal(requests, 2);
  assert.deepEqual(scheduled.map(({ id, name, input }) => ({ id, name, input })), [
    { id: "native-read", name: "read_file", input: { path: "actual.txt" } },
  ]);
  assert.equal(durable[0]!.content.find((block) => block.type === "text")?.text, literalToolExamples.think);
  assert.equal(events.find((event) => event.type === "turn_completed")?.result.type, "success");
});

function createLoop(
  execute: AgentRouterRuntime["execute"],
  onSchedule: (calls: CanonicalToolCall[]) => void,
): AgentLoop {
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
    execute,
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
  };
  return new AgentLoop(config, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          onSchedule(calls);
          return calls.map((call) => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: "fixture tool result" }],
            startedAt: new Date(0).toISOString(),
            completedAt: new Date(0).toISOString(),
          }));
        },
      },
    },
    context,
  });
}
