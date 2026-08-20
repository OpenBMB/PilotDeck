import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";

import type { Gateway, GatewayEvent } from "../../src/gateway/index.js";
import { WebhookChannel } from "../../src/adapters/channel/webhook/WebhookChannel.js";

test("Webhook public start exposes health, validates HMAC, accepts and deduplicates deliveries", async (t) => {
  const port = await freePort();
  const logs: string[] = [];
  const delivered = deferred<void>();
  const channel = new WebhookChannel({ port, secret: "secret", routes: { alerts: { deliver: "log" } } });
  const gateway = gatewayFrom(async function* (input) {
    assert.equal(input.channelKey, "webhook");
    assert.equal(input.message, "hello webhook");
    yield { type: "assistant_text_delta", text: "webhook reply" } satisfies GatewayEvent;
    yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
    delivered.resolve();
  });
  const handle = await channel.start({ gateway, logger: { info: message => logs.push(message) } });
  t.after(() => handle.stop("test cleanup"));

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", platform: "webhook" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`)).status, 404);

  const body = JSON.stringify({ text: "hello webhook" });
  const bad = await fetch(`http://127.0.0.1:${port}/webhooks/alerts`, { method: "POST", headers: { "content-type": "application/json", "x-delivery-id": "delivery-1", "x-signature-256": "bad" }, body });
  assert.equal(bad.status, 401);
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  const accepted = await fetch(`http://127.0.0.1:${port}/webhooks/alerts`, { method: "POST", headers: { "content-type": "application/json", "x-delivery-id": "delivery-1", "x-signature-256": signature }, body });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, "accepted");
  await withTimeout(delivered.promise);
  assert.ok(logs.some(log => log.includes("webhook reply")));

  const duplicate = await fetch(`http://127.0.0.1:${port}/webhooks/alerts`, { method: "POST", headers: { "content-type": "application/json", "x-delivery-id": "delivery-1", "x-signature-256": signature }, body });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).status, "duplicate");
});

test("Webhook stop releases its public HTTP port", async (t) => {
  const port = await freePort();
  const channel = new WebhookChannel({ port, routes: { test: { secret: "__INSECURE_NO_AUTH__" } } });
  const handle = await channel.start({ gateway: gatewayFrom(async function* () {}) });
  await handle.stop("release");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  t.after(() => handle.stop("cleanup"));
});

function gatewayFrom(submitTurn: Gateway["submitTurn"]): Gateway {
  return { submitTurn } as unknown as Gateway;
}
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> { return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]); }
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(typeof address === "object" && address ? address.port : 0)); });
  });
}
