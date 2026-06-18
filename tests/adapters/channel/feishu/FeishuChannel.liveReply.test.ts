import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FeishuChannel } from "../../../../src/adapters/channel/feishu/FeishuChannel.js";
import type { Gateway, GatewayEvent } from "../../../../src/gateway/index.js";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeResponse(): PassThrough {
  const response = new PassThrough() as PassThrough & {
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    statusCode?: number;
    headers?: Record<string, string>;
  };
  response.writeHead = (statusCode: number, headers?: Record<string, string>) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  return response;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function* events(items: GatewayEvent[]): AsyncIterable<GatewayEvent> {
  for (const item of items) {
    yield item;
  }
}

function makeGateway(
  items: GatewayEvent[] | (() => AsyncIterable<GatewayEvent>),
  options: { abortTurn?: Gateway["abortTurn"] } = {},
): Gateway {
  return {
    submitTurn: () => Array.isArray(items) ? events(items) : items(),
    abortTurn: options.abortTurn ?? (async () => undefined),
  } as unknown as Gateway;
}

async function runWebhook(channel: FeishuChannel, body: unknown): Promise<void> {
  const req = new PassThrough();
  const res = makeResponse();
  await channel.handleWebhook(req as any, res as any, JSON.stringify(body));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(label);
}

function requestText(call: FetchCall | undefined): string {
  assert.ok(call, "expected fetch call");
  const body = JSON.parse(String(call.init?.body)) as { content?: string };
  const content = JSON.parse(body.content ?? "{}") as {
    text?: string;
    elements?: Array<{ text?: { content?: string } }>;
  };
  return content.text ?? content.elements?.[0]?.text?.content ?? "";
}

function requestMsgType(call: FetchCall | undefined): string {
  assert.ok(call, "expected fetch call");
  return (JSON.parse(String(call.init?.body)) as { msg_type?: string }).msg_type ?? "";
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("feishu short replies send once at final without a cursor preview", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_1" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({ appId: "cli_a", appSecret: "secret", connectionMode: "webhook" });
    await channel.start({ gateway: makeGateway([{ type: "assistant_text_delta", text: "hello" }]) });
    await runWebhook(channel, { chatId: "oc_1", text: "hi", eventId: "evt_1" });
    await waitFor(
      () => calls.some((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?")),
      "expected Feishu final message call",
    );
    await wait(20);

    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    const edits = calls.filter((call) => call.init?.method === "PATCH");

    assert.equal(sends.length, 1);
    assert.equal(edits.length, 0);
    assert.deepEqual(JSON.parse(String(sends[0]?.init?.body)), {
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu live reply sends a long preview before turn completion", async () => {
  const calls: FetchCall[] = [];
  const releaseTurn = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_1" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({ appId: "cli_a", appSecret: "secret", connectionMode: "webhook" });
    await channel.start({
      gateway: makeGateway(async function* () {
        yield { type: "assistant_text_delta", text: "hello visible reply above threshold" };
        await releaseTurn.promise;
      }),
    });
    await runWebhook(channel, { chatId: "oc_2", text: "hi", eventId: "evt_2" });

    await waitFor(
      () => calls.some((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?")),
      "expected Feishu preview message call",
    );
    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    assert.equal(sends.length, 1);
    assert.equal(requestText(sends[0]), "hello visible reply above threshold ▉");
    assert.equal(requestMsgType(sends[0]), "interactive");
    assert.equal(calls.some((call) => call.init?.method === "PATCH"), false);

    releaseTurn.resolve();
    await waitFor(() => calls.some((call) => call.init?.method === "PATCH"), "expected final update call");
    const edit = calls.find((call) => call.init?.method === "PATCH");
    assert.equal(requestText(edit), "hello visible reply above threshold");
    assert.equal(requestMsgType(edit), "interactive");
  } finally {
    releaseTurn.resolve();
    globalThis.fetch = originalFetch;
  }
});

test("feishu long pre-text activity placeholder is reused for the answer", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_1" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({
      appId: "cli_a",
      appSecret: "secret",
      connectionMode: "webhook",
      liveReplyOptions: {
        activityDelayMs: 5,
        activityUpdateThrottleMs: 10_000,
        initialBufferThreshold: 5,
      },
    });
    await channel.start({
      gateway: makeGateway(async function* () {
        yield { type: "model_request_started", model: "m", provider: "p" };
        await wait(20);
        yield { type: "assistant_text_delta", text: "answer" };
      }),
    });
    await runWebhook(channel, { chatId: "oc_3", text: "hi", eventId: "evt_3" });

    await waitFor(
      () => calls.some((call) => call.init?.method === "PATCH"),
      "expected answer to update activity placeholder",
    );

    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    const edits = calls.filter((call) => call.init?.method === "PATCH");
    assert.equal(sends.length, 1);
    assert.equal(requestText(sends[0]), "正在思考… ▉");
    assert.equal(requestMsgType(sends[0]), "interactive");
    assert.equal(requestText(edits[0]), "answer ▉");
    assert.equal(requestMsgType(edits[0]), "interactive");
    assert.equal(requestText(edits.at(-1)), "answer");
    assert.ok(edits.every((call) => call.url.endsWith("/om_1")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu live reply falls back to final continuation when update fails", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 99991672, msg: "permission denied" });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      const messageNo = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?")).length;
      return jsonResponse({ code: 0, data: { message_id: `om_${messageNo}` } });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({
      appId: "cli_a",
      appSecret: "secret",
      connectionMode: "webhook",
      liveReplyOptions: { initialBufferThreshold: 5 },
    });
    await channel.start({
      gateway: makeGateway([
        { type: "assistant_text_delta", text: "hello" },
        { type: "assistant_text_delta", text: " world" },
      ]),
      logger: { warn: () => undefined },
    });
    await runWebhook(channel, { chatId: "oc_4", text: "hi", eventId: "evt_4" });
    await waitFor(
      () => calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?")).length >= 2,
      "expected fallback continuation send",
    );

    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    assert.equal(sends.length, 2);
    assert.equal(requestText(sends[0]), "hello ▉");
    assert.equal(requestMsgType(sends[0]), "interactive");
    assert.equal(requestText(sends[1]), "world");
    assert.equal(requestMsgType(sends[1]), "text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu live reply watchdog aborts long turns and edits card to timeout guidance", async () => {
  const calls: FetchCall[] = [];
  const aborts: Array<{ sessionKey: string; runId?: string }> = [];
  const releaseTurn = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_timeout" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({
      appId: "cli_a",
      appSecret: "secret",
      connectionMode: "webhook",
      liveReplyOptions: {
        activityDelayMs: 5,
        activityUpdateThrottleMs: 10_000,
        turnTimeoutMs: 20,
      },
    });
    await channel.start({
      gateway: makeGateway(async function* () {
        yield { type: "turn_started", runId: "run_timeout" };
        yield { type: "model_request_started", model: "m", provider: "p" };
        await releaseTurn.promise;
      }, {
        abortTurn: async (input) => {
          aborts.push(input);
          releaseTurn.resolve();
        },
      }),
    });
    await runWebhook(channel, { chatId: "oc_timeout", text: "hi", eventId: "evt_timeout" });

    await waitFor(
      () => aborts.length === 1 && calls.some((call) => call.init?.method === "PATCH"),
      "expected watchdog abort and timeout card update",
    );

    assert.deepEqual(aborts, [{ sessionKey: "feishu:chat=oc_timeout:general", runId: "run_timeout" }]);
    const sends = calls.filter((call) => call.init?.method === "POST" && call.url.includes("/im/v1/messages?"));
    const edits = calls.filter((call) => call.init?.method === "PATCH");
    assert.equal(requestText(sends[0]), "正在思考… ▉");
    assert.equal(requestMsgType(sends[0]), "interactive");
    assert.equal(requestText(edits.at(-1)), "处理超时，请重新发送或稍后重试。");
    assert.equal(requestMsgType(edits.at(-1)), "interactive");
  } finally {
    releaseTurn.resolve();
    globalThis.fetch = originalFetch;
  }
});

test("feishu agent_aborted updates live card once without raw error text", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "token", expire: 7200 });
    }
    if (init?.method === "POST" && String(url).includes("/im/v1/messages?")) {
      return jsonResponse({ code: 0, data: { message_id: "om_abort" } });
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ code: 0 });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;

  try {
    const channel = new FeishuChannel({
      appId: "cli_a",
      appSecret: "secret",
      connectionMode: "webhook",
      liveReplyOptions: {
        activityDelayMs: 5,
        activityUpdateThrottleMs: 10_000,
        turnTimeoutMs: 10_000,
      },
    });
    await channel.start({
      gateway: makeGateway(async function* () {
        yield { type: "turn_started", runId: "run_abort" };
        yield { type: "model_request_started", model: "m", provider: "p" };
        await wait(20);
        yield { type: "error", code: "agent_aborted", message: "Session aborted.", recoverable: true };
      }),
    });
    await runWebhook(channel, { chatId: "oc_abort", text: "hi", eventId: "evt_abort" });

    await waitFor(
      () => calls.some((call) => call.init?.method === "PATCH"),
      "expected aborted update",
    );

    const texts = calls
      .filter((call) => call.init?.method === "POST" || call.init?.method === "PATCH")
      .map((call) => requestText(call));
    assert.ok(texts.includes("正在思考… ▉"));
    assert.ok(texts.includes("处理已中止，请重新发送或稍后重试。"));
    assert.equal(texts.some((text) => text.includes("Session aborted")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("feishu elicitation request is delivered by existing immediate path", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const channel = new FeishuChannel({
    connectionMode: "webhook",
    liveReplyOptions: { activityDelayMs: 5 },
    send: async (message) => {
      sent.push(message);
    },
  });
  await channel.start({
    gateway: makeGateway([
      { type: "model_request_started", model: "m", provider: "p" },
      {
        type: "elicitation_request",
        requestId: "req_1",
        toolCallId: "tool_1",
        toolName: "ask_user_question",
        questions: [
          {
            header: "确认",
            question: "继续吗？",
            options: [{ label: "继续", description: "执行下一步" }],
          },
        ],
      },
    ]),
  });

  await runWebhook(channel, { chatId: "oc_5", text: "hi", eventId: "evt_5" });
  await wait(20);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, "oc_5");
  assert.match(sent[0]?.text ?? "", /继续吗/);
});
