import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { StaffDeckSopDiscoveryClient } from "../../src/sop/staffdeck/StaffDeckSopDiscoveryClient.js";

test("StaffDeck discovery client sends the authenticated native route request", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new StaffDeckSopDiscoveryClient("https://staffdeck.test/api/v1", "agent-1", "sd_live_secret", {
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        decision: "start_new_task",
        selected_sop_id: "purchase",
        target_step_id: "start",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.route({ message: "buy something", sessionId: "session-1" });
  assert.equal(result.selectedSopId, "purchase");
  assert.equal(request?.url, "https://staffdeck.test/api/v1/agents/agent-1/sops:route");
  assert.equal(request?.init?.headers && new Headers(request.init.headers).get("authorization"), "Bearer sd_live_secret");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    message: "buy something",
    model_source: "pilotdeck_host",
    session_id: "session-1",
  });
});

test("discovery bounds delayed responses, honors cancellation, and preserves HTTP errors", async () => {
  const delayedFetch: typeof fetch = async (_url, init) => {
    await delay(40, undefined, { signal: init?.signal ?? undefined });
    return Response.json({ decision: "ordinary_chat", selected_sop_id: null });
  };
  const input = { message: "hello", sessionId: "delayed" };
  const short = new StaffDeckSopDiscoveryClient("http://sd.test", "agent", "test", { fetch: delayedFetch, timeoutMs: 10 });
  await assert.rejects(short.route(input), { code: "SOP_DISCOVERY_UNAVAILABLE" });
  const long = new StaffDeckSopDiscoveryClient("http://sd.test", "agent", "test", { fetch: delayedFetch, timeoutMs: 200 });
  assert.equal((await long.route(input)).decision, "ordinary_chat");
  const controller = new AbortController();
  const cancelled = long.route({ ...input, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { code: "SOP_DISCOVERY_UNAVAILABLE" });
  const unavailable = new StaffDeckSopDiscoveryClient("http://sd.test", "agent", "test", {
    fetch: async () => Response.json({ code: "PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE" }, { status: 503 }),
  });
  await assert.rejects(unavailable.route(input), { code: "PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE" });
});
