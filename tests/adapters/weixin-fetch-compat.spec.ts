import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WeixinChannel, type WeixinIlinkClient } from "../../src/adapters/channel/weixin/WeixinChannel.js";
import type { Gateway } from "../../src/gateway/index.js";

test("Weixin iLink fetch removes content-length without changing unrelated requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-weixin-fetch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({
    baseUrl: "https://ilink.example",
    botToken: "token",
    accountId: "account",
  }));

  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; headers?: HeadersInit }> = [];
  globalThis.fetch = async (input, init) => {
    captured.push({ url: String(input), headers: init?.headers });
    return new Response("ok");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let releasePoll!: () => void;
  const polling = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const client: WeixinIlinkClient = {
    cursor: "",
    poll: async () => {
      await polling;
      return { ret: 0, msgs: [] };
    },
    sendTextChunked: async () => 1,
    sendMedia: async () => undefined,
    getUploadUrl: async () => ({}),
    sendTyping: async () => undefined,
  };
  const channel = new WeixinChannel({ credentialsPath, clientFactory: () => client });
  const handle = await channel.start({ gateway: {} as Gateway });

  await globalThis.fetch("https://ilink.example/ilink/bot/send", {
    headers: { "Content-Length": "12", Authorization: "Bearer token" },
  });
  await globalThis.fetch("https://other.example/upload", {
    headers: { "Content-Length": "34" },
  });

  assert.deepEqual(captured[0], {
    url: "https://ilink.example/ilink/bot/send",
    headers: { Authorization: "Bearer token" },
  });
  assert.deepEqual(captured[1], {
    url: "https://other.example/upload",
    headers: { "Content-Length": "34" },
  });

  const stopping = handle.stop("test");
  releasePoll();
  await stopping;
});
