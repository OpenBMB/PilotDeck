import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getEventListeners } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { NetworkFetchError, jitteredBackoff, networkFetch, networkFetchJson, normalizeNetworkError } from "../../src/network/fetch.js";

// Mock fetches have no socket to keep Node alive for unref'ed retry/deadline timers.
let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => clearInterval(keepAlive));

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status, headers });
}

test("networkFetch retries retryable status responses and then succeeds", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? response(500) : response(200);
  };

  const result = await networkFetch("https://example.test", {}, {
    fetchImpl,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });

  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("networkFetch uses retry-after when calculating retry delay", () => {
  assert.equal(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 10_000 }, "2"), 2000);
});

test("networkFetch caps retry-after delays with maxDelayMs", () => {
  assert.equal(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 5_000 }, "3600"), 5000);
});

test("networkFetch normalizes DNS and reset errors", () => {
  assert.equal(normalizeNetworkError(Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), { code: "ENOTFOUND" })).code, "network_dns_error");
  assert.equal(normalizeNetworkError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })).code, "network_connection_reset");
});

test("networkFetch times out requests", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

  await assert.rejects(
    networkFetch("https://example.test", {}, { fetchImpl, timeoutMs: 1 }),
    { code: "network_timeout" },
  );
});

test("networkFetch honors init.signal abort reasons without options.signal", async () => {
  const controller = new AbortController();
  const reason = new NetworkFetchError("network_timeout", "outer timeout");
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort(reason);
  });

  await assert.rejects(
    networkFetch("https://example.test", { signal: controller.signal }, { fetchImpl }),
    { code: "network_timeout" },
  );
});

test("networkFetch preserves parent NetworkFetchError reasons passed through options.signal", async () => {
  const controller = new AbortController();
  const reason = new NetworkFetchError("network_timeout", "configured timeout");
  const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort(reason);
  });

  await assert.rejects(
    networkFetch("https://example.test", {}, { fetchImpl, signal: controller.signal }),
    { code: "network_timeout" },
  );
});

async function localServer(t: test.TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("networkFetchJson times out and closes a real response stalled after headers", { timeout: 3000 }, async (t) => {
  let closed = false;
  let headersSent = false;
  const url = await localServer(t, (_req, res) => {
    res.on("close", () => { closed = true; });
    res.writeHead(200, { "content-type": "application/json" });
    res.write("\n");
    headersSent = true;
  });
  await assert.rejects(networkFetchJson(url, {}, { timeoutMs: 500 }), { code: "network_timeout" });
  assert.equal(headersSent, true);
  for (let i = 0; i < 50 && !closed; i += 1) await sleep(10);
  assert.equal(closed, true, "the upstream request must close, not just the body promise");
});

test("networkFetch cancels retry bodies and keeps the final response readable", { timeout: 3000 }, async (t) => {
  let calls = 0;
  let retryClosed = false;
  const url = await localServer(t, (_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.on("close", () => { retryClosed = true; });
      res.writeHead(503);
      res.write("retry body never ends");
    } else {
      res.end('{"ok":true}');
    }
  });
  const parent = new AbortController();
  const { json } = await networkFetchJson(url, {}, {
    signal: parent.signal, timeoutMs: 1000,
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  assert.deepEqual(json, { ok: true });
  assert.equal(calls, 2);
  assert.equal(retryClosed, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("networkFetch forwards caller cancellation while a real streaming body is being read", { timeout: 3000 }, async (t) => {
  let closed = false;
  const url = await localServer(t, (_req, res) => {
    res.on("close", () => { closed = true; });
    res.writeHead(200);
    res.write("first chunk");
  });
  const parent = new AbortController();
  const result = await networkFetch(url, { signal: parent.signal });
  const reader = result.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk");
  const pending = reader.read();
  parent.abort(new NetworkFetchError("network_abort", "caller cancelled"));
  await assert.rejects(pending, { code: "network_abort" });
  for (let i = 0; i < 50 && !closed; i += 1) await sleep(10);
  assert.equal(closed, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("networkFetch releases cancellation and timeout resources when the body finishes", async () => {
  const parent = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const result = await networkFetch("https://example.test", {}, {
    signal: parent.signal,
    timeoutMs: 50,
    fetchImpl: async (_url, init) => {
      requestSignal = init?.signal;
      return new Response('{"ok":true}');
    },
  });
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  assert.deepEqual(await result.json(), { ok: true });
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  await sleep(75);
  assert.equal(requestSignal?.aborted, false);
});

test("networkFetch releases resources on body cancellation, failure, and bodyless responses", async () => {
  for (const mode of ["cancel", "error", "empty"] as const) {
    const parent = new AbortController();
    const failure = new Error("body failed");
    const result = await networkFetch("https://example.test", {}, {
      signal: parent.signal,
      timeoutMs: 1000,
      fetchImpl: async () => mode === "empty" ? new Response(null, { status: 204 }) : new Response(new ReadableStream({
        pull(controller) { if (mode === "error") controller.error(failure); },
      })),
    });
    if (mode === "cancel") await result.body!.cancel();
    if (mode === "error") await assert.rejects(result.text(), /body failed/);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0, mode);
  }
});

test("networkFetch preserves redirected response metadata, cloning, and incremental reads", { timeout: 3000 }, async (t) => {
  const url = await localServer(t, (req, res) => {
    if (req.url === "/") { res.writeHead(302, { location: "/stream" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first");
    setTimeout(() => res.end("second"), 100);
  });
  const parent = new AbortController();
  const result = await networkFetch(url, {}, { signal: parent.signal, timeoutMs: 1000 });
  const clone = result.clone();
  for (const value of [result, clone, clone.clone()]) {
    assert.equal(value.url, `${url}/stream`);
    assert.equal(value.redirected, true);
    assert.equal(value.type, "basic");
    assert.equal(value.headers.get("content-type"), "text/plain");
  }
  const reader = result.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
  assert.equal((await reader.read()).done, true);
  assert.equal(await clone.text(), "firstsecond");
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});
