import assert from "node:assert/strict";
import test from "node:test";
import { NetworkFetchError, jitteredBackoff, networkFetch, normalizeNetworkError } from "../../src/network/fetch.js";

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
