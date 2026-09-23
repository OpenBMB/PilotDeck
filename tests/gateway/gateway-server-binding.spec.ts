import assert from "node:assert/strict";
import test from "node:test";

import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import type { Gateway } from "../../src/gateway/protocol/types.js";

const gateway = {} as Gateway;

test("GatewayServer keeps non-loopback binding opt-in", async () => {
  await assert.rejects(
    () => startGatewayServer({ gateway, host: "0.0.0.0", port: 0, token: "remote-token" }),
    /allowRemoteHost=true/,
  );
});

test("GatewayServer requires an explicit token for remote binding", async () => {
  await assert.rejects(
    () => startGatewayServer({ gateway, host: "0.0.0.0", port: 0, allowRemoteHost: true }),
    /explicit auth token/,
  );
});

test("remote Gateway binding serves health but never exposes the local token endpoint", async (t) => {
  const server = await startGatewayServer({
    gateway,
    host: "0.0.0.0",
    port: 0,
    allowRemoteHost: true,
    token: "remote-token",
  });
  t.after(() => server.close());

  const localUrl = server.url.replace("0.0.0.0", "127.0.0.1");
  assert.equal((await fetch(`${localUrl}/health`)).status, 200);
  assert.equal((await fetch(`${localUrl}/auth/local-token`)).status, 404);
});

test("remote Gateway binding accepts an authenticated SDK WebSocket", async (t) => {
  const server = await startGatewayServer({
    gateway: {
      describeServer: async () => ({ mode: "in_process", capabilities: [] }),
    } as unknown as Gateway,
    host: "0.0.0.0",
    port: 0,
    allowRemoteHost: true,
    token: "remote-sdk-token",
  });
  const wsUrl = server.wsUrl.replace("0.0.0.0", "127.0.0.1");
  const client = new GatewayWsClient({ url: wsUrl, token: server.token, clientName: "sdk" });
  t.after(async () => {
    client.close();
    await server.close();
  });

  await client.connect();
  const info = await new RemoteGateway(client).describeServer();
  assert.equal(info.mode, "in_process");
});

test("remote Gateway binding rejects an incorrect SDK token", async (t) => {
  const server = await startGatewayServer({
    gateway: {
      describeServer: async () => ({ mode: "in_process", capabilities: [] }),
    } as unknown as Gateway,
    host: "0.0.0.0",
    port: 0,
    allowRemoteHost: true,
    token: "remote-sdk-token",
  });
  const client = new GatewayWsClient({
    url: server.wsUrl.replace("0.0.0.0", "127.0.0.1"),
    token: "wrong-token",
    clientName: "sdk",
  });
  t.after(async () => {
    client.close();
    await server.close();
  });

  await assert.rejects(() => client.connect(), /auth_failed|closed|Gateway WebSocket/);
});
