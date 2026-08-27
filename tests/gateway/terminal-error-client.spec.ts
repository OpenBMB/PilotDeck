import test from "node:test";
import assert from "node:assert/strict";

import { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { GatewayBrowserClient } from "../../src/web/client/GatewayBrowserClient.js";

const errorEvent = {
  type: "error",
  code: "gateway_stream_ended_without_completion",
  message: "Gateway stream ended without a turn_completed event.",
  recoverable: true,
} as const;

test("GatewayWsClient delivers an error carried by the final stream frame", async () => {
  const client = new GatewayWsClient({ url: "ws://test", token: "token" });
  (client as any).ws = { readyState: 1, send() {} };
  const stream = client.stream("submit_turn", {});
  (client as any).handleMessage(JSON.stringify({ type: "event", id: "ignored", seq: 0, final: true, event: errorEvent }));
  const id = [...(client as any).streams.keys()][0];
  assert.ok(id);
  (client as any).handleMessage(JSON.stringify({ type: "event", id, seq: 0, final: true, event: errorEvent }));
  assert.deepEqual((await stream[Symbol.asyncIterator]().next()).value, errorEvent);
  assert.equal((await stream[Symbol.asyncIterator]().next()).done, true);
});

test("GatewayBrowserClient delivers an error carried by the final stream frame", async () => {
  const client = new GatewayBrowserClient({ url: "ws://test", token: "token", newId: () => "browser-stream" });
  (client as any).hello = { protocolVersion: "test" };
  (client as any).ws = { readyState: 1, send() {}, close() {}, addEventListener() {} };
  const stream = client.submitTurn({ sessionKey: "web:test", channelKey: "web", message: "hello" });
  (client as any).handleMessage(JSON.stringify({ type: "event", id: "browser-stream", seq: 0, final: true, event: errorEvent }));
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, errorEvent);
  assert.equal((await iterator.next()).done, true);
});
