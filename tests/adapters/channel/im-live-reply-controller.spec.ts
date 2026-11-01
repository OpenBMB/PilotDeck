import test from "node:test";
import assert from "node:assert/strict";

import {
  ImLiveReplyController,
  type ImLiveReplyTransport,
} from "../../../src/adapters/channel/protocol/ImLiveReplyController.js";
import { toSlackMrkdwn } from "../../../src/adapters/channel/slack/SlackChannel.js";

type Handle = { id: number };
type FakeMessage = { text: string; edits: number };

const CURSOR = " ▉";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** In-memory IM that behaves like Feishu: slow round trips and an optional per-message edit cap. */
function fakeIm(options: {
  latencyMs: number;
  maxMessageLength?: number;
  maxEditsPerMessage?: number;
  formatText?: (text: string) => string;
}) {
  const messages: FakeMessage[] = [];
  const log: string[] = [];
  let rejectedEdits = 0;
  const transport: ImLiveReplyTransport<Handle> = {
    maxMessageLength: options.maxMessageLength,
    maxEditsPerMessage: options.maxEditsPerMessage,
    formatText: options.formatText,
    send: async (text) => {
      await sleep(options.latencyMs);
      messages.push({ text, edits: 0 });
      log.push(text);
      return { id: messages.length - 1 };
    },
    edit: async (handle, text) => {
      await sleep(options.latencyMs);
      const message = messages[handle.id]!;
      if (options.maxEditsPerMessage && message.edits >= options.maxEditsPerMessage) {
        rejectedEdits += 1;
        return false;
      }
      message.edits += 1;
      message.text = text;
      log.push(text);
      return true;
    },
  };
  return {
    transport,
    messages,
    log,
    get rejectedEdits() {
      return rejectedEdits;
    },
    visibleText: () => messages.map((message) => message.text).join(""),
  };
}

function textDelta(text: string) {
  return { type: "assistant_text_delta", text } as const;
}

test("streaming deltas never wait on slow IM edits and the final text is complete", async () => {
  const im = fakeIm({ latencyMs: 150, maxMessageLength: 4_000 });
  const controller = new ImLiveReplyController<Handle>({
    transport: im.transport,
    throttleMs: 20,
    minEditIntervalMs: 20,
    initialThrottleMs: 0,
    activityDelayMs: -1,
  });

  let expected = "";
  let slowest = 0;
  const startedAt = Date.now();
  for (let i = 0; i < 300; i++) {
    const piece = `${String(i).padStart(4, "0")}______`;
    expected += piece;
    const before = Date.now();
    await controller.handleEvent(textDelta(piece) as never);
    slowest = Math.max(slowest, Date.now() - before);
  }
  const streamMs = Date.now() - startedAt;
  await controller.flushFinal();

  assert.ok(slowest < 50, `handleEvent blocked for ${slowest}ms`);
  assert.ok(streamMs < 500, `consuming 300 deltas took ${streamMs}ms`);
  assert.equal(im.visibleText(), expected);
  assert.ok(!im.messages.some((message) => message.text.includes(CURSOR)), "cursor left behind");
});

test("long replies roll over to a new message before the platform edit cap", async () => {
  const im = fakeIm({ latencyMs: 2, maxMessageLength: 4_000, maxEditsPerMessage: 5 });
  const controller = new ImLiveReplyController<Handle>({
    transport: im.transport,
    throttleMs: 10,
    minEditIntervalMs: 10,
    initialThrottleMs: 0,
    activityDelayMs: -1,
  });

  let expected = "";
  for (let i = 0; i < 80; i++) {
    const piece = `${String(i).padStart(3, "0")}|`;
    expected += piece;
    await controller.handleEvent(textDelta(piece) as never);
    await sleep(15);
  }
  await controller.flushFinal();

  assert.equal(im.rejectedEdits, 0);
  assert.ok(im.messages.length > 1, "expected the reply to continue in a new message");
  for (const message of im.messages) assert.ok(message.edits <= 5, `message edited ${message.edits} times`);
  assert.equal(im.visibleText(), expected);
  assert.ok(!im.messages.some((message) => message.text.includes(CURSOR)), "cursor left behind");
});

test("text that grows when formatted rolls over instead of being truncated", async () => {
  const maxMessageLength = 500;
  const im = fakeIm({ latencyMs: 1, maxMessageLength, formatText: toSlackMrkdwn });
  const controller = new ImLiveReplyController<Handle>({
    transport: im.transport,
    throttleMs: 5,
    minEditIntervalMs: 5,
    initialThrottleMs: 0,
    activityDelayMs: -1,
  });

  // Every "<", ">" and "&" becomes a 4-5 character entity in Slack.
  const line = "if (a < b && c > d) return x => y;\n";
  let expected = "";
  while (expected.length < 3_000) expected += line;
  for (let i = 0; i < expected.length; i += 50) {
    await controller.handleEvent(textDelta(expected.slice(i, i + 50)) as never);
  }
  await controller.flushFinal();

  for (const message of im.messages) {
    assert.ok(message.text.length <= maxMessageLength, `message has ${message.text.length} chars`);
  }
  assert.equal(im.visibleText(), toSlackMrkdwn(expected));
});

test("pauseActivity lets text finalized at a tool boundary land before an out-of-band prompt", async () => {
  const im = fakeIm({ latencyMs: 80, maxMessageLength: 4_000 });
  const controller = new ImLiveReplyController<Handle>({
    transport: im.transport,
    throttleMs: 1_000,
    initialThrottleMs: 1_000,
    activityDelayMs: -1,
  });

  const intro = "Let me check the repository layout first.";
  await controller.handleEvent(textDelta(intro) as never);
  await controller.handleEvent({ type: "tool_call_started", name: "bash", toolCallId: "t1" } as never);
  await controller.pauseActivity();
  im.log.push("PERMISSION PROMPT");
  await controller.flushFinal();

  const introIndex = im.log.indexOf(intro);
  assert.ok(introIndex !== -1, `intro never delivered without cursor: ${JSON.stringify(im.log)}`);
  assert.ok(introIndex < im.log.indexOf("PERMISSION PROMPT"), `prompt overtook the reply: ${JSON.stringify(im.log)}`);
});
