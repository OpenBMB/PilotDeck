import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { FeishuChannel } from "../../src/adapters/index.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

test("Feishu webhook captures an elicitation and pairs the public reply with the Gateway request", async (t) => {
  const chatId = "oc_test";
  const submitted: GatewaySubmitTurnInput[] = [];
  const answers: unknown[] = [];
  const promptSent = deferred<void>();
  const answerDelivered = deferred<void>();
  const finishTurn = deferred<void>();
  const keepAlive = setInterval(() => undefined, 25);
  const sent: Array<{ chatId: string; text: string }> = [];
  const gateway = {
    submitTurn: async function* (input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      submitted.push(input);
      yield {
        type: "elicitation_request",
        requestId: "request-1",
        toolCallId: "tool-1",
        toolName: "ask_user_question",
        questions: [{
          header: "Deploy",
          question: "Where should this deploy?",
          options: [
            { label: "Staging", description: "Internal validation" },
            { label: "Production", description: "Customer traffic" },
          ],
          multiSelect: false,
        }],
      };
      await finishTurn.promise;
    },
    respondElicitation: async (input: unknown) => {
      answers.push(input);
      answerDelivered.resolve();
      finishTurn.resolve();
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    send: async (message) => {
      sent.push(message);
      if (message.text.includes("Where should this deploy?")) promptSent.resolve();
    },
    liveReplyOptions: { turnTimeoutMs: 0 },
  });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(async () => {
    clearInterval(keepAlive);
    finishTurn.resolve();
    await handle.stop("test");
  });

  const firstResponse = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    firstResponse as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "deploy the app", eventId: "message-1" }),
  );
  await withTimeout(promptSent.promise, "Feishu elicitation prompt");

  const secondResponse = createMockResponse();
  await channel.handleWebhook(
    {} as IncomingMessage,
    secondResponse as unknown as ServerResponse,
    JSON.stringify({ chatId, text: "2", eventId: "message-2" }),
  );
  await withTimeout(answerDelivered.promise, "Feishu elicitation response");

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.channelKey, "feishu");
  assert.equal(submitted[0]?.message, "deploy the app");
  assert.match(sent[0]?.text ?? "", /Production/);
  assert.deepEqual(answers, [{
    sessionKey: submitted[0]?.sessionKey,
    requestId: "request-1",
    answer: { type: "answered", answers: { "Where should this deploy?": "Production" } },
  }]);
});

function createMockResponse(): { statusCode?: number; body?: string; writeHead(statusCode: number): void; end(body: string): void } {
  return {
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error(`timed out waiting for ${label}`)), { once: true });
    }),
  ]);
}
