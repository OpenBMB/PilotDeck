import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import { SlackChannel } from "../../../src/adapters/channel/slack/SlackChannel.js";

test("Slack does not open a Socket Mode connection after stop() raced apps.connections.open", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.send(JSON.stringify({ type: "hello" }));
  });
  const { port } = server.address() as AddressInfo;

  try {
    const channel = new SlackChannel({ botToken: "xoxb-test", appToken: "xapp-test" });
    const internals = channel as unknown as {
      stopped: boolean;
      ws: unknown;
      api: (method: string) => Promise<unknown>;
      openConnection: () => Promise<void>;
    };
    internals.stopped = false;
    internals.api = async (method: string) => {
      assert.equal(method, "apps.connections.open");
      // The channel is stopped (hot reload / disable) while the request is in flight.
      internals.stopped = true;
      return { url: `ws://127.0.0.1:${port}/` };
    };

    await internals.openConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(connections, 0);
    assert.equal(internals.ws, null);
  } finally {
    // Drop any connection a regression may have opened so close() cannot hang.
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
