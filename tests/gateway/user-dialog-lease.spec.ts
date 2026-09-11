import assert from "node:assert/strict";
import test from "node:test";

import { GatewayUserDialogBus } from "../../src/gateway/user-dialog/GatewayUserDialogBus.js";
import type { GatewayUserDialogRequestEvent } from "../../src/gateway/protocol/types.js";

const request: GatewayUserDialogRequestEvent = {
  type: "user_dialog_request",
  requestId: "dialog-1",
  dialogKind: "input",
  toolCallId: "tool-1",
  toolName: "request_user_input",
  prompt: "Which test command should I run?",
};

test("user-dialog lease serializes renderers, supports renewal, and expires without blocking a response", () => {
  let nowMs = Date.parse("2026-09-11T00:00:00.000Z");
  let settled = 0;
  const bus = new GatewayUserDialogBus({
    now: () => new Date(nowMs),
    uuid: () => "lease-1",
  });
  bus.register("session-1", {
    requestId: request.requestId,
    dialogKind: "input",
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    event: request,
    accepts: (value) => typeof value === "string",
    resolve: () => {},
    reject: () => {},
    onSettled: () => { settled += 1; },
  });

  const first = bus.claim("session-1", request.requestId, 1_000);
  assert.deepEqual(first, {
    claimed: true,
    lease: { leaseId: "lease-1", expiresAt: "2026-09-11T00:00:01.000Z" },
  });
  assert.deepEqual(bus.list("session-1"), [{
    ...request,
    lease: { expiresAt: "2026-09-11T00:00:01.000Z" },
  }]);
  assert.deepEqual(bus.claim("session-1", request.requestId, 1_000), {
    claimed: false,
    reason: "claimed",
    expiresAt: "2026-09-11T00:00:01.000Z",
  });
  assert.deepEqual(bus.consumeForResponse("session-1", request.requestId), {
    entry: undefined,
    reason: "lease_required",
  });

  nowMs += 500;
  const renewed = bus.claim("session-1", request.requestId, 1_500, "lease-1");
  assert.deepEqual(renewed, {
    claimed: true,
    lease: { leaseId: "lease-1", expiresAt: "2026-09-11T00:00:02.000Z" },
  });

  nowMs = Date.parse("2026-09-11T00:00:02.000Z");
  assert.deepEqual(bus.list("session-1"), [request]);
  const consumed = bus.consumeForResponse("session-1", request.requestId);
  assert.ok(consumed.entry);
  assert.equal(settled, 1);
  assert.deepEqual(bus.claim("session-1", request.requestId, 1_000), {
    claimed: false,
    reason: "not_pending",
  });
});

test("user-dialog observation changes are hints and never change the owned lease or response path", () => {
  let nowMs = Date.parse("2026-09-11T00:00:00.000Z");
  const changes: Array<Record<string, unknown>> = [];
  const bus = new GatewayUserDialogBus({
    now: () => new Date(nowMs),
    uuid: () => "lease-observation",
    onChange: (change) => changes.push(change),
  });
  bus.register("session-1", {
    requestId: request.requestId,
    dialogKind: "input",
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    event: request,
    accepts: (value) => typeof value === "string",
    resolve: () => {},
    reject: () => {},
  });
  const claim = bus.claim("session-1", request.requestId, 1_000);
  assert.equal(claim.claimed, true);
  nowMs += 1_000;
  assert.deepEqual(bus.list("session-1"), [request]);
  assert.ok(bus.consumeForResponse("session-1", request.requestId).entry);

  assert.deepEqual(changes, [
    { type: "requested", sessionKey: "session-1", request },
    {
      type: "lease_changed",
      sessionKey: "session-1",
      requestId: request.requestId,
      action: "claimed",
      expiresAt: "2026-09-11T00:00:01.000Z",
    },
    {
      type: "lease_changed",
      sessionKey: "session-1",
      requestId: request.requestId,
      action: "expired",
    },
    {
      type: "settled",
      sessionKey: "session-1",
      requestId: request.requestId,
      reason: "answered",
    },
  ]);
});
