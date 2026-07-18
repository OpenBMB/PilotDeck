import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WeixinChannel } from "../../src/adapters/index.js";
import {
  createChannelRuntimeStatusReporter,
  readChannelRuntimeStatusSnapshot,
  type ChannelRuntimeStatusUpdate,
} from "../../src/adapters/channel/protocol/ChannelRuntimeStatus.js";
import type { Gateway, GatewayChannelKey } from "../../src/gateway/index.js";

test("WeixinChannel.start returns while QR login is waiting", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);

  const tempDir = await mkdtemp(join(tmpdir(), "pilotdeck-weixin-start-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const updates: Array<{ channelKey: GatewayChannelKey; update: ChannelRuntimeStatusUpdate }> = [];
  const channel = new WeixinChannel({
    credentialsPath: join(tempDir, "weixin-credentials.json"),
    loginWithQR: async ({ onQRCode }) => {
      onQRCode?.("https://wechat.example/qr");
      return new Promise(() => undefined);
    },
  });

  const handle = await Promise.race([
    channel.start({
      gateway: {} as Gateway,
      reportChannelStatus: (channelKey, update) => updates.push({ channelKey, update }),
    }),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);

  assert.notEqual(handle, "timeout");
  assert.ok(
    updates.some((entry) =>
      entry.channelKey === "weixin" && entry.update.state === "waiting_for_login"
    ),
  );
  assert.ok(
    updates.some((entry) =>
      entry.channelKey === "weixin"
      && entry.update.state === "waiting_for_login"
      && entry.update.qrUrl === "https://wechat.example/qr"
    ),
  );

  await (handle as Awaited<ReturnType<WeixinChannel["start"]>>).stop("test");
});

test("channel runtime status reporter persists the latest channel state", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-channel-status-"));
  t.after(async () => {
    await rm(pilotHome, { recursive: true, force: true });
  });

  const report = createChannelRuntimeStatusReporter(pilotHome);
  report("weixin", {
    state: "waiting_for_login",
    message: "微信等待扫码登录",
    qrUrl: "https://wechat.example/qr",
  });

  const snapshot = readChannelRuntimeStatusSnapshot(pilotHome);
  assert.equal(snapshot.channels.weixin.channelKey, "weixin");
  assert.equal(snapshot.channels.weixin.state, "waiting_for_login");
  assert.equal(snapshot.channels.weixin.message, "微信等待扫码登录");
  assert.equal(snapshot.channels.weixin.qrUrl, "https://wechat.example/qr");
});
