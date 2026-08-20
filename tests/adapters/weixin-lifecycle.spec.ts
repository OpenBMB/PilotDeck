import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MessageItemType } from "weixin-ilink";

import { WeixinChannel, type WeixinIlinkClient } from "../../src/adapters/channel/weixin/WeixinChannel.js";
import { ImChatSessionState } from "../../src/adapters/channel/protocol/ImChatSessionState.js";
import type { ChannelAttachment, Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

type QueuedTurn = {
  sessionKey: string;
  message: string;
  projectKey?: string;
  attachments: ChannelAttachment[];
};

const originalFetch = globalThis.fetch;
let fetchDispatch: typeof fetch = async (input) => {
  throw new Error(`unexpected Weixin fetch: ${String(input)}`);
};
globalThis.fetch = ((input, init) => fetchDispatch(input, init)) as typeof fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

test("Weixin public poll delays permission activity until the configured timer fires", async (t) => {
  const directory = await createCredentialsDirectory(t, "permission");
  const poller = new ControlledPoller();
  const outbound: string[] = [];
  const promptSent = deferred<void>();
  const confirmationSent = deferred<void>();
  const permissionDelivered = deferred<void>();
  const finishTurn = deferred<void>();
  const client = fakeClient(poller, {
    sendText: async (_userId, text) => {
      outbound.push(text);
      if (text.includes("需要权限")) promptSent.resolve();
      if (text.includes("已允许一次")) confirmationSent.resolve();
    },
  });
  const gateway = {
    submitTurn: async function* (): AsyncIterable<GatewayEvent> {
      yield {
        type: "permission_request",
        requestId: "permission-1",
        toolName: "bash",
        payload: { command: "pwd" },
      };
      await finishTurn.promise;
    },
    permissionDecide: async (input: unknown) => {
      assert.deepEqual(input, {
        sessionKey: "weixin:chat=user-1:general",
        requestId: "permission-1",
        decision: "allow",
        remember: false,
      });
      permissionDelivered.resolve();
      return { delivered: true };
    },
  } as unknown as Gateway;
  poller.push([textMessage("user-1", "run pwd")]);
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    clientFactory: () => client,
    liveReplyOptions: { activityDelayMs: 0, activityUpdateThrottleMs: 60_000, turnTimeoutMs: 0 },
  });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(async () => {
    finishTurn.resolve();
    await stopChannel(handle, poller);
  });

  await withTimeout(promptSent.promise, "Weixin permission prompt");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  poller.push([textMessage("user-1", "1")]);
  await withTimeout(permissionDelivered.promise, "Weixin permission decision");
  await withTimeout(confirmationSent.promise, "Weixin permission confirmation");
  assert.equal(outbound.some((text) => text.includes("仍在处理：正在执行工具")), false);

  t.mock.timers.tick(0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(outbound.some((text) => text.includes("仍在处理：正在执行工具")), true);
});

test("Weixin public poll drains busy messages FIFO and snapshots queued attachments", async (t) => {
  const directory = await createCredentialsDirectory(t, "queue");
  const previousHome = process.env.HOME;
  process.env.HOME = directory;
  t.after(() => {
    process.env.HOME = previousHome;
  });
  fetchDispatch = async (input) => {
    assert.equal(String(input), "https://cdn.example/queued.pdf");
    return new Response(Buffer.from("%PDF-1.7\nqueued"), { status: 200 });
  };
  const poller = new ControlledPoller();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondSubmitted = deferred<void>();
  const submissions: GatewaySubmitTurnInput[] = [];
  const logs: string[] = [];
  const gateway = {
    submitTurn: async function* (input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      submissions.push(input);
      if (input.message === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondSubmitted.resolve();
      }
    },
  } as unknown as Gateway;
  const client = fakeClient(poller);
  poller.push([textMessage("user-1", "first")]);
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    clientFactory: () => client,
    liveReplyOptions: { turnTimeoutMs: 0 },
  });
  const handle = await channel.start({ gateway, logger: { info: (message: string) => logs.push(message) } });
  t.after(async () => {
    releaseFirst.resolve();
    await stopChannel(handle, poller);
  });

  await withTimeout(firstStarted.promise, "first Weixin turn");
  poller.push([fileMessage("user-1", "second", "queued.pdf", "https://cdn.example/queued.pdf")]);
  await waitFor(() => logs.some((message) => message.includes("already active, queued message")), "queued Weixin message log");
  await waitFor(() => submissions.length === 1, "queued Weixin turn to remain pending");
  releaseFirst.resolve();
  await withTimeout(secondSubmitted.promise, "second Weixin turn");

  assert.deepEqual(submissions.map((input) => input.message), ["first", "second"]);
  assert.equal(submissions[1]?.attachments?.length, 1);
  assert.equal(submissions[1]?.attachments?.[0]?.name, "queued.pdf");
});

test("Weixin public poll decrypts a nested encrypted file before Gateway submission", async (t) => {
  const directory = await createCredentialsDirectory(t, "decrypt");
  const previousHome = process.env.HOME;
  process.env.HOME = directory;
  t.after(() => {
    process.env.HOME = previousHome;
  });
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("%PDF-1.7\nfixture");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  fetchDispatch = async (input) => {
    assert.equal(String(input), "https://cdn.example/report.enc");
    return new Response(encrypted, { status: 200 });
  };
  const poller = new ControlledPoller();
  const submitted = deferred<GatewaySubmitTurnInput>();
  const gateway = {
    submitTurn: async function* (input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      submitted.resolve(input);
    },
  } as unknown as Gateway;
  poller.push([encryptedFileMessage("user-1", key)]);
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    clientFactory: () => fakeClient(poller),
    liveReplyOptions: { turnTimeoutMs: 0 },
  });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(() => stopChannel(handle, poller));

  const input = await withTimeout(submitted.promise, "decrypted Weixin attachment");
  const saved = input.attachments?.[0];
  assert.equal(saved?.name, "report.pdf");
  assert.ok(saved?.path);
  assert.deepEqual(await readFile(saved.path), plaintext);
});

test("Weixin public Gateway stream sends only explicit assistant_attachment events as media", async (t) => {
  const directory = await createCredentialsDirectory(t, "outbound-attachment");
  const reportPath = join(directory, "report.pdf");
  await writeFile(reportPath, "%PDF-1.7\nreport");
  fetchDispatch = async (input) => {
    assert.equal(String(input), "https://upload.example/report");
    return new Response("", { status: 200, headers: { "x-encrypted-param": "download-token" } });
  };
  const poller = new ControlledPoller();
  const mediaSent = deferred<{ userId: string; item: unknown; contextToken: string }>();
  const keepAlive = setInterval(() => undefined, 25);
  const client = fakeClient(poller, {
    getUploadUrl: async () => ({ upload_full_url: "https://upload.example/report" }),
    sendMedia: async (userId, item, contextToken) => {
      mediaSent.resolve({ userId, item, contextToken });
    },
  });
  const gateway = {
    submitTurn: async function* (): AsyncIterable<GatewayEvent> {
      yield {
        type: "assistant_attachment",
        attachment: { type: "file", path: reportPath, name: "report.pdf", source: "tool_result" },
      };
    },
  } as unknown as Gateway;
  poller.push([textMessage("user-1", "create a report")]);
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    clientFactory: () => client,
    liveReplyOptions: { turnTimeoutMs: 0 },
  });
  const handle = await channel.start({ gateway, logger: {} });
  t.after(() => clearInterval(keepAlive));
  t.after(() => stopChannel(handle, poller));

  const delivered = await withTimeout(mediaSent.promise, "explicit Weixin assistant attachment");
  assert.equal(delivered.userId, "user-1");
  assert.equal(delivered.contextToken, "context-1");
  assert.equal((delivered.item as { file_item?: { file_name?: string } }).file_item?.file_name, "report.pdf");
});

test("Weixin public poll rebuilds a recoverable client with the live cursor", async (t) => {
  const directory = await createCredentialsDirectory(t, "rebuild", "stored-cursor");
  const replacementPoller = new ControlledPoller();
  const clients: WeixinIlinkClient[] = [];
  const replacementCreated = deferred<void>();
  const first = fakeClient({
    poll: async () => {
      first.cursor = "live-cursor";
      throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    },
  });
  const replacement = fakeClient(replacementPoller);
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    clientFactory: () => {
      const client = clients.length === 0 ? first : replacement;
      clients.push(client);
      if (clients.length === 2) replacementCreated.resolve();
      return client;
    },
  });
  const handle = await channel.start({ gateway: {} as Gateway, logger: {} });
  t.after(() => stopChannel(handle, replacementPoller));

  await withTimeout(replacementCreated.promise, "replacement Weixin poll client");
  assert.equal(clients.length, 2);
  assert.equal(replacement.cursor, "live-cursor");
});

test("Weixin starts polling when a background QR login completes after start returns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-weixin-login-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(console, "log", () => undefined);
  const login = deferred<{ baseUrl: string; botToken: string; accountId: string }>();
  const poller = new ControlledPoller();
  const clientCreated = deferred<void>();
  const keepAlive = setInterval(() => undefined, 25);
  let createCount = 0;
  const channel = new WeixinChannel({
    credentialsPath: join(directory, "credentials.json"),
    loginWithQR: async () => login.promise,
    clientFactory: () => {
      createCount++;
      clientCreated.resolve();
      return fakeClient(poller);
    },
  });
  t.after(() => clearInterval(keepAlive));

  const handle = await channel.start({ gateway: {} as Gateway, logger: {} });
  login.resolve({ baseUrl: "https://ilink.example", botToken: "token", accountId: "account" });
  await withTimeout(clientCreated.promise, "post-login Weixin poll client");
  assert.equal(createCount, 1);
  await stopChannel(handle, poller);
});

test("IM queued-turn state caps backlog, isolates chats, and resets stale active runs", () => {
  const state = new ImChatSessionState<QueuedTurn>({ maxPendingTurns: 2 });
  const makeTurn = (message: string): QueuedTurn => ({ sessionKey: "session-1", message, attachments: [] });

  state.queueTurn("chat-1", makeTurn("oldest"));
  state.queueTurn("chat-1", makeTurn("middle"));
  state.queueTurn("chat-1", makeTurn("newest"));
  state.queueTurn("chat-2", makeTurn("other"));
  state.setActiveRun("chat-1", { sessionKey: "session-1", runId: "run-1", generation: 0 });

  assert.equal(state.shiftTurn("chat-1")?.message, "middle");
  assert.equal(state.shiftTurn("chat-1")?.message, "newest");
  assert.equal(state.shiftTurn("chat-1"), undefined);
  assert.equal(state.shiftTurn("chat-2")?.message, "other");
  state.queueTurn("chat-1", makeTurn("stale"));
  state.resetForNewSession("chat-1");
  assert.equal(state.generation("chat-1"), 1);
  assert.equal(state.shiftTurn("chat-1"), undefined);
  assert.equal(state.activeRun("chat-1"), undefined);
});

class ControlledPoller {
  private readonly queued: unknown[][] = [];
  private waiter?: (value: { ret: number; msgs: unknown[] }) => void;

  push(messages: unknown[]): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ ret: 0, msgs: messages });
      return;
    }
    this.queued.push(messages);
  }

  async poll(): Promise<{ ret: number; msgs: unknown[] }> {
    const messages = this.queued.shift();
    if (messages) return { ret: 0, msgs: messages };
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  release(): void {
    this.push([]);
  }
}

function fakeClient(
  poller: { poll(): Promise<unknown> },
  options: {
    sendText?: (userId: string, text: string, contextToken: string) => Promise<void>;
    sendMedia?: (userId: string, item: unknown, contextToken: string) => Promise<void>;
    getUploadUrl?: () => Promise<Record<string, unknown>>;
  } = {},
): WeixinIlinkClient {
  return {
    cursor: "",
    poll: poller.poll.bind(poller) as WeixinIlinkClient["poll"],
    sendTextChunked: async (userId, text, contextToken) => {
      await options.sendText?.(userId, text, contextToken);
      return 1;
    },
    sendMedia: async (userId, item, contextToken) => options.sendMedia?.(userId, item, contextToken),
    getUploadUrl: async () => (await options.getUploadUrl?.() ?? {}),
    sendTyping: async () => undefined,
  };
}

function textMessage(userId: string, text: string): unknown {
  return {
    message_type: 1,
    from_user_id: userId,
    context_token: "context-1",
    message_id: `${userId}-${text}`,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function fileMessage(userId: string, text: string, name: string, url: string): unknown {
  const message = textMessage(userId, text) as { item_list: unknown[] };
  message.item_list.push({ type: MessageItemType.FILE, file_item: { file_name: name, url } });
  return message;
}

function encryptedFileMessage(userId: string, key: Buffer): unknown {
  return {
    message_type: 1,
    from_user_id: userId,
    context_token: "context-1",
    message_id: "encrypted-file",
    item_list: [{
      type: MessageItemType.FILE,
      file_item: {
        file_name: "report.pdf",
        aeskey: key.toString("hex"),
        media: { full_url: "https://cdn.example/report.enc" },
      },
    }],
  };
}

async function createCredentialsDirectory(
  t: TestContext,
  label: string,
  cursor?: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pilotdeck-weixin-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "credentials.json"), JSON.stringify({
    baseUrl: "https://ilink.example",
    botToken: "token",
    accountId: "account",
    ...(cursor ? { cursor } : {}),
  }));
  return directory;
}

async function stopChannel(handle: { stop(reason?: string): Promise<void> }, poller: ControlledPoller): Promise<void> {
  const stopping = handle.stop("test");
  poller.release();
  await stopping;
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
