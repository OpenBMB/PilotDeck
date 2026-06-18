import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ImLiveReplyController,
  type ImLiveReplyActivity,
  type ImLiveReplyTransport,
} from "../../../../src/adapters/channel/protocol/ImLiveReplyController.js";

type Call =
  | { kind: "send"; text: string }
  | { kind: "edit"; handle: string; text: string }
  | { kind: "pulseActivity"; activity: ImLiveReplyActivity }
  | { kind: "stopActivity" };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTransport(options: {
  editable?: boolean;
  failEditAt?: number;
  nativeActivity?: boolean;
} = {}): { calls: Call[]; transport: ImLiveReplyTransport<string> } {
  const calls: Call[] = [];
  let nextHandle = 1;
  let editCount = 0;
  return {
    calls,
    transport: {
      send: async (text) => {
        calls.push({ kind: "send", text });
        if (options.editable === false) return undefined;
        return `m${nextHandle++}`;
      },
      edit: options.editable === false
        ? undefined
        : async (handle, text) => {
            editCount++;
            if (options.failEditAt === editCount) {
              return false;
            }
            calls.push({ kind: "edit", handle, text });
            return true;
          },
      pulseActivity: options.nativeActivity
        ? async (activity) => {
            calls.push({ kind: "pulseActivity", activity });
            return true;
          }
        : undefined,
      stopActivity: options.nativeActivity
        ? async () => {
            calls.push({ kind: "stopActivity" });
          }
        : undefined,
    },
  };
}

test("short first assistant delta is buffered instead of sent immediately", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialThrottleMs: 10_000,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });

  assert.deepEqual(calls, []);

  await controller.flushFinal();
  assert.deepEqual(calls, [{ kind: "send", text: "hello" }]);
});

test("activity does not start before a gateway event asks for it", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await wait(20);
  await controller.flushFinal();

  assert.deepEqual(calls, []);
});

test("first reply preview sends when initial threshold is reached", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 5,
    initialThrottleMs: 10_000,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });

  assert.deepEqual(calls, [{ kind: "send", text: "hello ▉" }]);
});

test("first reply preview sends when initial throttle elapses", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 100,
    initialThrottleMs: 5,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await wait(20);

  assert.deepEqual(calls, [{ kind: "send", text: "hello ▉" }]);
});

test("multiple deltas are throttled into a limited edit", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 5,
    throttleMs: 10_000,
    bufferThreshold: 1_000,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " " });
  await controller.handleEvent({ type: "assistant_text_delta", text: "world" });

  assert.deepEqual(calls, [{ kind: "send", text: "hello ▉" }]);

  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "edit", handle: "m1", text: "hello world" },
  ]);
});

test("activity placeholder is sent after long pre-text wait", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await controller.handleEvent({ type: "model_request_started", model: "m", provider: "p" });
  await wait(20);

  assert.deepEqual(calls, [{ kind: "send", text: "正在思考… ▉" }]);
});

test("assistant text reuses activity placeholder handle", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 5,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await controller.handleEvent({ type: "model_request_started", model: "m", provider: "p" });
  await wait(20);
  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "正在思考… ▉" },
    { kind: "edit", handle: "m1", text: "hello ▉" },
    { kind: "edit", handle: "m1", text: "hello" },
  ]);
});

test("thinking delta content is not sent to IM", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_thinking_delta", text: "secret chain of thought" });
  await wait(20);

  assert.deepEqual(calls, [{ kind: "send", text: "正在思考… ▉" }]);
});

test("subagent and tool status are throttled as activity updates", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10,
    activityMaxUpdates: 2,
    formatActivity: ({ kind, updateCount }) => (
      kind === "subagent"
        ? `正在处理子任务…#${updateCount}`
        : `正在执行工具…#${updateCount}`
    ),
  });

  await controller.handleEvent({
    type: "agent_status",
    event: "subagent_started",
    detail: { subagentId: "s1", subagentType: "general" },
  });
  await wait(20);
  await wait(20);
  await wait(20);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { kind: "send", text: "正在处理子任务…#1 ▉" });
  assert.equal(calls[1]?.kind, "edit");
  assert.equal((calls[1] as Extract<Call, { kind: "edit" }>).handle, "m1");
  assert.equal((calls[1] as Extract<Call, { kind: "edit" }>).text, "正在处理子任务…#2 ▉");
});

test("tool boundary finalizes the current segment and starts a new one", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 10,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "before tool" });
  await controller.handleEvent({ type: "tool_call_started", toolCallId: "t1", name: "shell" });
  await controller.handleEvent({ type: "assistant_text_delta", text: "after tool" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "before tool ▉" },
    { kind: "edit", handle: "m1", text: "before tool" },
    { kind: "send", text: "after tool ▉" },
    { kind: "edit", handle: "m2", text: "after tool" },
  ]);
});

test("final flush removes cursor from the visible message", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 4,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "done" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "done ▉" },
    { kind: "edit", handle: "m1", text: "done" },
  ]);
});

test("activity-only turn is finalized without cursor", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await controller.handleEvent({ type: "model_request_started", model: "m", provider: "p" });
  await wait(20);
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "正在思考… ▉" },
    { kind: "edit", handle: "m1", text: "处理完成，但没有可见回复。" },
  ]);
});

test("turn timeout does not finalize before the configured timeout", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
    turnTimeoutMs: 100,
  });

  await controller.handleEvent({ type: "turn_started", runId: "r1" });
  await wait(20);

  assert.deepEqual(calls, [{ kind: "send", text: "正在思考… ▉" }]);

  await controller.flushFinal();
});

test("turn timeout edits activity placeholder to retry guidance", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
    turnTimeoutMs: 20,
  });

  await controller.handleEvent({ type: "turn_started", runId: "r1" });
  await wait(50);
  await controller.handleEvent({ type: "assistant_text_delta", text: "late text" });

  assert.deepEqual(calls, [
    { kind: "send", text: "正在思考… ▉" },
    { kind: "edit", handle: "m1", text: "处理超时，请重新发送或稍后重试。" },
  ]);
});

test("non-editable transport sends timeout final once", async () => {
  const { calls, transport } = makeTransport({ editable: false });
  const controller = new ImLiveReplyController({
    transport,
    turnTimeoutMs: 5,
  });

  await controller.handleEvent({ type: "turn_started", runId: "r1" });
  await wait(20);
  await controller.markTimedOut();

  assert.deepEqual(calls, [{ kind: "send", text: "处理超时，请重新发送或稍后重试。" }]);
});

test("native activity is stopped when turn times out", async () => {
  const { calls, transport } = makeTransport({ nativeActivity: true });
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
    turnTimeoutMs: 20,
  });

  await controller.handleEvent({ type: "turn_started", runId: "r1" });
  await wait(50);

  assert.equal(calls[0]?.kind, "pulseActivity");
  assert.deepEqual(calls.slice(-2), [
    { kind: "stopActivity" },
    { kind: "send", text: "处理超时，请重新发送或稍后重试。" },
  ]);
});

test("markAborted sends retry guidance instead of raw aborted error", async () => {
  const { calls, transport } = makeTransport();
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
    turnTimeoutMs: 10_000,
  });

  await controller.handleEvent({ type: "turn_started", runId: "r1" });
  await wait(20);
  await controller.markAborted();

  assert.deepEqual(calls, [
    { kind: "send", text: "正在思考… ▉" },
    { kind: "edit", handle: "m1", text: "处理已中止，请重新发送或稍后重试。" },
  ]);
});

test("edit failure sends only the unseen continuation", async () => {
  const { calls, transport } = makeTransport({ failEditAt: 1 });
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 5,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "edit", handle: "m1", text: "hello" },
    { kind: "send", text: "world" },
  ]);
});

test("non-editable transport skips live activity and sends final reply once", async () => {
  const { calls, transport } = makeTransport({ editable: false });
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 5,
    activityDelayMs: 5,
  });

  await controller.handleEvent({ type: "model_request_started", model: "m", provider: "p" });
  await wait(20);
  await controller.handleEvent({ type: "assistant_text_delta", text: "hello world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [{ kind: "send", text: "hello world" }]);
});

test("long replies split into multiple live segments", async () => {
  const { calls, transport } = makeTransport();
  transport.maxMessageLength = 8;
  const controller = new ImLiveReplyController({
    transport,
    initialBufferThreshold: 1,
    throttleMs: 10_000,
    cursor: " ▉",
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "abcdefghij" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "abcdef ▉" },
    { kind: "edit", handle: "m1", text: "abcdef" },
    { kind: "send", text: "ghij ▉" },
    { kind: "edit", handle: "m2", text: "ghij" },
  ]);
});

test("initial send failure does not mark text as visible", async () => {
  const calls: Call[] = [];
  const controller = new ImLiveReplyController<string>({
    transport: {
      send: async (text) => {
        calls.push({ kind: "send", text });
        return false;
      },
      edit: async (handle, text) => {
        calls.push({ kind: "edit", handle, text });
        return true;
      },
    },
    initialBufferThreshold: 5,
    activityDelayMs: 10_000,
  });

  await controller.handleEvent({ type: "assistant_text_delta", text: "hello" });
  await controller.handleEvent({ type: "assistant_text_delta", text: " world" });
  await controller.flushFinal();

  assert.deepEqual(calls, [
    { kind: "send", text: "hello ▉" },
    { kind: "send", text: "hello world" },
  ]);
});

test("native activity transports receive pulses but no placeholder message", async () => {
  const { calls, transport } = makeTransport({ nativeActivity: true });
  const controller = new ImLiveReplyController({
    transport,
    activityDelayMs: 5,
    activityUpdateThrottleMs: 10_000,
  });

  await controller.handleEvent({ type: "model_request_started", model: "m", provider: "p" });
  await wait(20);
  await controller.flushFinal();

  assert.equal(calls[0]?.kind, "pulseActivity");
  assert.deepEqual(calls.at(-1), { kind: "stopActivity" });
});
