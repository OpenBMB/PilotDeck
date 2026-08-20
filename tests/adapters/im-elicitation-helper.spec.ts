import assert from "node:assert/strict";
import test from "node:test";

import { ImElicitationHelper } from "../../src/adapters/channel/protocol/ImElicitationHelper.js";
import type { Gateway, GatewayEvent } from "../../src/gateway/index.js";

const REQUEST: GatewayEvent & { type: "elicitation_request" } = {
  type: "elicitation_request",
  requestId: "request-1",
  toolCallId: "tool-1",
  toolName: "ask_user_question",
  questions: [
    {
      header: "Deployment",
      question: "Where should this deploy?",
      options: [
        { label: "Staging", description: "Internal validation" },
        { label: "Production", description: "Customer traffic" },
      ],
      multiSelect: false,
    },
  ],
};

test("IM elicitation renders the question, descriptions, choices, and reply instructions", () => {
  const helper = new ImElicitationHelper();

  const prompt = helper.capture("chat-1", "session-1", REQUEST);

  assert.equal(helper.hasPending("chat-1"), true);
  assert.match(prompt, /\*\*Deployment\*\*/);
  assert.match(prompt, /Where should this deploy\?/);
  assert.match(prompt, /1\. Staging — Internal validation/);
  assert.match(prompt, /2\. Production — Customer traffic/);
  assert.match(prompt, /回复数字选择/);
  assert.match(prompt, /回复 0 取消/);
});

test("IM elicitation maps numeric and multi-select answers back to option labels", async () => {
  const helper = new ImElicitationHelper();
  const calls: unknown[] = [];
  const gateway = createGateway(calls);

  helper.capture("chat-single", "session-single", REQUEST);
  helper.capture("chat-multi", "session-multi", {
    ...REQUEST,
    requestId: "request-multi",
    questions: [{ ...REQUEST.questions[0], multiSelect: true }],
  });

  assert.equal(await helper.answer("chat-single", "2", gateway), undefined);
  assert.equal(await helper.answer("chat-multi", "1， 2", gateway), undefined);
  assert.deepEqual(calls, [
    {
      sessionKey: "session-single",
      requestId: "request-1",
      answer: { type: "answered", answers: { "Where should this deploy?": "Production" } },
    },
    {
      sessionKey: "session-multi",
      requestId: "request-multi",
      answer: { type: "answered", answers: { "Where should this deploy?": ["Staging", "Production"] } },
    },
  ]);
  assert.equal(helper.hasPending("chat-single"), false);
  assert.equal(helper.hasPending("chat-multi"), false);
});

test("IM elicitation preserves free-form answers and sends an explicit cancellation", async () => {
  const helper = new ImElicitationHelper();
  const calls: unknown[] = [];
  const gateway = createGateway(calls);

  helper.capture("chat-free", "session-free", REQUEST);
  helper.capture("chat-cancel", "session-cancel", { ...REQUEST, requestId: "request-cancel" });

  assert.equal(await helper.answer("chat-free", "A private environment", gateway), undefined);
  assert.equal(await helper.answer("chat-cancel", " 0 ", gateway), "已取消。");
  assert.deepEqual(calls, [
    {
      sessionKey: "session-free",
      requestId: "request-1",
      answer: {
        type: "answered",
        answers: { "Where should this deploy?": "A private environment" },
      },
    },
    {
      sessionKey: "session-cancel",
      requestId: "request-cancel",
      answer: { type: "cancelled", reason: "user cancelled" },
    },
  ]);
});

test("IM elicitation keeps pending state isolated by chat and supports explicit cleanup", async () => {
  const helper = new ImElicitationHelper();
  const calls: unknown[] = [];
  const gateway = createGateway(calls);

  helper.capture("chat-1", "session-1", REQUEST);
  helper.capture("chat-2", "session-2", { ...REQUEST, requestId: "request-2" });
  helper.clear("chat-1");

  assert.equal(helper.hasPending("chat-1"), false);
  assert.equal(helper.hasPending("chat-2"), true);
  assert.equal(await helper.answer("chat-1", "1", gateway), undefined);
  assert.equal(await helper.answer("chat-2", "1", gateway), undefined);
  assert.deepEqual(calls, [
    {
      sessionKey: "session-2",
      requestId: "request-2",
      answer: { type: "answered", answers: { "Where should this deploy?": "Staging" } },
    },
  ]);
});

function createGateway(calls: unknown[]): Gateway {
  return {
    respondElicitation: async (input: unknown) => {
      calls.push(input);
      return { delivered: true };
    },
  } as unknown as Gateway;
}
