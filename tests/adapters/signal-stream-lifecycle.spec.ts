import assert from "node:assert/strict";
import test from "node:test";

import { SignalChannel } from "../../src/adapters/channel/signal/SignalChannel.js";
import type { CronResultDelivery } from "../../src/cron/index.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

const ACCOUNT = "+15550001111";
const SENDER = "+15550002222";

test("Signal public SSE loop handles a permission answer while its turn is still pending", async (t) => {
  const stream = controlledSse();
  const sent: string[] = [];
  const promptSent = deferred<void>();
  const permissionDelivered = deferred<void>();
  const finishTurn = deferred<void>();
  const keepAlive = setInterval(() => undefined, 25);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/receive/")) {
      init?.signal?.addEventListener("abort", () => stream.close(), { once: true });
      return new Response(stream.body, { status: 200 });
    }
    if (url.endsWith("/v2/send")) {
      const body = JSON.parse(String(init?.body)) as { message: string };
      sent.push(body.message);
      if (body.message.includes("需要权限")) promptSent.resolve();
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected Signal fetch: ${url}`);
  };
  t.after(() => {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  });

  const gateway = {
    submitTurn: async function* (_input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      yield {
        type: "permission_request",
        requestId: "permission-1",
        toolName: "bash",
        payload: { command: "pwd" },
      };
      await finishTurn.promise;
    },
    permissionDecide: async (input: unknown) => {
      permissionDelivered.resolve();
      assert.deepEqual(input, {
        sessionKey: `signal:chat=dm:${SENDER}:general`,
        requestId: "permission-1",
        decision: "allow",
        remember: false,
      });
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new SignalChannel({ account: ACCOUNT, restUrl: "http://signal.test" });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(async () => {
    finishTurn.resolve();
    stream.close();
    await handle.stop("test");
  });

  stream.send(signalEnvelope("run the command"));
  await withTimeout(promptSent.promise, "Signal permission prompt");
  stream.send(signalEnvelope("1"));
  await withTimeout(permissionDelivered.promise, "Signal permission response");

  assert.equal(sent.some((text) => text.includes("已允许一次")), true);
});

test("Signal public SSE loop routes an elicitation answer through the Gateway", async (t) => {
  const stream = controlledSse();
  const answerDelivered = deferred<void>();
  const promptSent = deferred<void>();
  const finishTurn = deferred<void>();
  const keepAlive = setInterval(() => undefined, 25);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/receive/")) {
      init?.signal?.addEventListener("abort", () => stream.close(), { once: true });
      return new Response(stream.body, { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { message: string };
    if (body.message.includes("Where should this deploy?")) promptSent.resolve();
    return new Response("ok", { status: 200 });
  };
  t.after(async () => {
    clearInterval(keepAlive);
    finishTurn.resolve();
    stream.close();
    globalThis.fetch = originalFetch;
  });
  const gateway = {
    submitTurn: async function* (): AsyncIterable<GatewayEvent> {
      yield {
        type: "elicitation_request",
        requestId: "elicitation-1",
        toolCallId: "tool-1",
        toolName: "ask_user_question",
        questions: [{
          header: "Deploy",
          question: "Where should this deploy?",
          options: [{ label: "Staging", description: "Internal" }, { label: "Production", description: "Public" }],
        }],
      };
      await finishTurn.promise;
    },
    respondElicitation: async (input: unknown) => {
      assert.deepEqual(input, {
        sessionKey: `signal:chat=dm:${SENDER}:general`,
        requestId: "elicitation-1",
        answer: { type: "answered", answers: { "Where should this deploy?": "Production" } },
      });
      answerDelivered.resolve();
      return { delivered: true };
    },
  } as unknown as Gateway;
  const channel = new SignalChannel({ account: ACCOUNT, restUrl: "http://signal.test" });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(() => handle.stop("test"));

  stream.send(signalEnvelope("deploy the app"));
  await withTimeout(promptSent.promise, "Signal elicitation prompt");
  stream.send(signalEnvelope("2"));
  await withTimeout(answerDelivered.promise, "Signal elicitation response");
});

test("Signal Cron delivery uses the started channel send transport", async (t) => {
  const stream = controlledSse();
  const sent = deferred<{ message: string; recipients: string[] }>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/receive/")) {
      init?.signal?.addEventListener("abort", () => stream.close(), { once: true });
      return new Response(stream.body, { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { message: string; recipients: string[] };
    sent.resolve(body);
    return new Response("ok", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const channel = new SignalChannel({ account: ACCOUNT, restUrl: "http://signal.test" });
  const handle = await channel.start({ gateway: {} as Gateway, logger: {} });
  t.after(async () => {
    stream.close();
    await handle.stop("test");
  });
  const delivery: CronResultDelivery = {
    taskId: "task-1",
    runId: "run-1",
    sessionKey: `signal:chat=dm:${SENDER}:general`,
    channelKey: "cron",
    originSessionKey: `signal:chat=dm:${SENDER}:general`,
    originChannelKey: "signal",
    outcome: "completed",
    text: "cron result",
  };

  assert.equal(await channel.deliverCronResult(delivery), true);
  assert.deepEqual(await withTimeout(sent.promise, "Signal Cron send"), {
    message: "cron result",
    number: ACCOUNT,
    recipients: [SENDER],
  });
});

function signalEnvelope(message: string): Record<string, unknown> {
  return { envelope: { sourceNumber: SENDER, dataMessage: { message, timestamp: Date.now() } } };
}

function controlledSse(): { body: ReadableStream<Uint8Array>; send(value: unknown): void; close(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    body,
    send(value) {
      if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n`));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
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
