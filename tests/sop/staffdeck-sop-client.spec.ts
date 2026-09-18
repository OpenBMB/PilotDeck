import assert from "node:assert/strict";
import test from "node:test";

import { StaffDeckSopClient, StaffDeckSopClientError } from "../../src/sop/staffdeck/StaffDeckSopClient.js";

const bundle = { sops: [{ id: "onboarding", content: { nodes: [{ node_id: "start" }] } }] };
const state = { selected_skill_id: "onboarding" };
const manifest = {
  status: "ok",
  protocolVersion: "2.0",
  moduleId: "sop.runtime",
  contract: "sop.lifecycle/v2",
  operations: ["prepare", "submit"],
};

test("SOP client validates the manifest and wraps calls with the v2 execution envelope", async () => {
  const requests: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url: String(url), method: init?.method, body });
      if (String(url).endsWith("/healthz")) return json(manifest);
      return json({
        protocolVersion: "2.0",
        requestId: body?.requestId,
        ok: true,
        outcome: "completed",
        payload: preparePayload(),
      });
    },
  });

  const response = await client.prepare({
    bundle,
    state,
    context: {
      runId: "run-1",
      operationId: "op-1",
      requestId: "request-1",
      sessionId: "session-1",
      turnId: "turn-1",
      idempotencyKey: "prepare-1",
      expectedRevision: 3,
    },
  });

  assert.equal(response.state.status, "active");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "http://sop.test/healthz");
  assert.deepEqual(requests[1]?.body, {
    protocolVersion: "2.0",
    runId: "run-1",
    operationId: "op-1",
    requestId: "request-1",
    sessionId: "session-1",
    turnId: "turn-1",
    idempotencyKey: "prepare-1",
    expectedRevision: 3,
    payload: { bundle, state },
  });
});

test("SOP client preserves semantic runtime rejection codes and retryability", async () => {
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) return json(manifest);
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return json({
        protocolVersion: "2.0",
        requestId: body.requestId,
        ok: false,
        outcome: "failed",
        error: {
          code: "REQUIRED_CAPABILITY_NOT_INVOKED",
          message: "Tool is required.",
          retryability: "unsafe",
          details: { missingToolNames: ["lookup"] },
        },
      }, 422);
    },
  });

  await assert.rejects(
    () => client.prepare({ bundle, state }),
    (error: unknown) => error instanceof StaffDeckSopClientError
      && error.code === "REQUIRED_CAPABILITY_NOT_INVOKED"
      && error.retryability === "unsafe"
      && Array.isArray(error.details?.missingToolNames)
      && error.details.missingToolNames[0] === "lookup",
  );
});

test("SOP client rejects an incompatible manifest before posting a SOP operation", async () => {
  let posts = 0;
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (_url, init) => {
      if (init?.method === "POST") posts += 1;
      return json({ ...manifest, contract: "sop.lifecycle/v1" });
    },
  });

  await assert.rejects(
    () => client.prepare({ bundle, state }),
    (error: unknown) => error instanceof StaffDeckSopClientError && error.code === "SOP_PROTOCOL_INCOMPATIBLE",
  );
  assert.equal(posts, 0);
});

test("SOP client rejects malformed successful envelopes", async () => {
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (url) => String(url).endsWith("/healthz") ? json(manifest) : json([]),
  });

  await assert.rejects(
    () => client.prepare({ bundle, state }),
    (error: unknown) => error instanceof StaffDeckSopClientError && error.code === "SOP_RUNTIME_PROTOCOL",
  );
});

test("SOP client rejects malformed prepare and submit payloads before the host can persist them", async () => {
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) return json(manifest);
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return json({
        protocolVersion: "2.0",
        requestId: body.requestId,
        ok: true,
        outcome: "completed",
        payload: { state: { status: "active" }, step: {} },
      });
    },
  });

  await assert.rejects(
    () => client.prepare({ bundle, state }),
    (error: unknown) => error instanceof StaffDeckSopClientError
      && error.code === "SOP_RUNTIME_PROTOCOL"
      && error.retryability === "unsafe",
  );

  const submitClient = new StaffDeckSopClient("http://sop.test", {
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) return json(manifest);
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return json({ protocolVersion: "2.0", requestId: body.requestId, ok: true, outcome: "completed", payload: { state: {} } });
    },
  });
  await assert.rejects(
    () => submitClient.submit({ bundle, state, proposal: { status: "completed", replyFragment: "done" }, successfulToolNames: [] }),
    (error: unknown) => error instanceof StaffDeckSopClientError && error.code === "SOP_RUNTIME_PROTOCOL",
  );
});

test("SOP client accepts owner-defined null optional submit fields", async () => {
  const client = new StaffDeckSopClient("http://sidecar.test", {
    fetch: async (url, init) => {
      if (String(url).endsWith("/healthz")) return json(manifest);
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return json({
        protocolVersion: "2.0",
        requestId: body.requestId,
        ok: true,
        outcome: "completed",
        payload: {
          state: { selected_skill_id: "approval", status: "completed" },
          result: {
            status: "completed",
            replyFragment: "Approved.",
            slotUpdates: {},
            taskSummary: null,
            structuredResult: null,
            nextStepId: null,
            events: [],
          },
        },
      });
    },
  });
  const response = await client.submit({
    bundle: bundle,
    state: { selected_skill_id: "approval" },
    proposal: { status: "completed", replyFragment: "Approved." },
    successfulToolNames: [],
  });
  assert.equal(response.result.taskSummary, null);
  assert.equal(response.result.nextStepId, null);
});

test("SOP client marks timeouts retryable and caller cancellation unsafe", async () => {
  const client = new StaffDeckSopClient("http://sop.test", {
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort signal did not fire")), 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
    timeoutMs: 1,
  });

  await assert.rejects(
    () => client.prepare({ bundle, state }),
    (error: unknown) => error instanceof StaffDeckSopClientError
      && error.code === "SOP_RUNTIME_UNAVAILABLE"
      && error.retryability === "safe",
  );

  const controller = new AbortController();
  const cancelled = new StaffDeckSopClient("http://sop.test", {
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const request = cancelled.prepare({ bundle, state, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => request,
    (error: unknown) => error instanceof StaffDeckSopClientError
      && error.code === "SOP_RUNTIME_CANCELLED"
      && error.retryability === "unsafe",
  );
});

function preparePayload() {
  return {
    state: { status: "active" },
    step: {
      skillId: "onboarding", skillName: "Onboarding", version: "1", nodeId: "start", node: {}, instruction: "Continue",
      expectedUserInfo: [], knownSlots: {}, allowedNextStepIds: [], requiredToolNames: [], allowedActions: [],
      isTerminal: false, declaresHandoff: false,
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
