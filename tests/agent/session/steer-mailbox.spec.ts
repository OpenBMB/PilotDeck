import assert from "node:assert/strict";
import test from "node:test";

import { SteerMailbox } from "../../../src/agent/session/SteerMailbox.js";
import type { AgentSteerMessage } from "../../../src/agent/session/SteerMailbox.js";

function steer(itemId: string, text = itemId): AgentSteerMessage {
  return {
    itemId,
    message: {
      role: "user",
      content: [{ type: "text", text }],
      metadata: { purpose: "mid_turn_steer", queueItemId: itemId },
    },
  };
}

test("steer mailbox accepts only the active turn and deduplicates retries", () => {
  const mailbox = new SteerMailbox();
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-1")), {
    accepted: false,
    reason: "no_active_turn",
  });

  mailbox.start("turn-1");
  assert.deepEqual(mailbox.enqueue("turn-2", steer("item-1")), {
    accepted: false,
    reason: "turn_mismatch",
  });
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-1", "adjust direction")), {
    accepted: true,
  });
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-1", "duplicate retry")), {
    accepted: true,
  });
  assert.deepEqual(mailbox.drain("turn-1").map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(mailbox.drain("turn-1"), []);
});

test("drainOrClose removes the terminal race without dropping accepted guidance", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("turn-1", steer("item-1"));

  const firstBoundary = mailbox.drainOrClose("turn-1");
  assert.equal(firstBoundary.closed, false);
  assert.deepEqual(firstBoundary.messages.map((entry) => entry.itemId), ["item-1"]);

  const terminalBoundary = mailbox.drainOrClose("turn-1");
  assert.deepEqual(terminalBoundary, { messages: [], closed: true });
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "turn_closing",
  });
});

test("finish returns unconsumed guidance so callers can leave it queued", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual(mailbox.finish("turn-1").map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "no_active_turn",
  });
});

test("close returns pending guidance while rejecting late submissions as turn_closing", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual(mailbox.close("turn-1").map((entry) => entry.itemId), ["item-1"]);
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-2")), {
    accepted: false,
    reason: "turn_closing",
  });
  assert.deepEqual(mailbox.finish("turn-1"), []);
});

test("pending guidance can be cancelled before a model boundary", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("turn-1", steer("item-1"));

  assert.deepEqual(mailbox.cancel("turn-1", "item-1"), { cancelled: true });
  assert.deepEqual(mailbox.cancel("turn-1", "item-1"), { cancelled: true });
  assert.deepEqual(mailbox.drain("turn-1"), []);
});

test("cancel tombstones win a race with enqueue, but drained guidance is too late", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");

  assert.deepEqual(mailbox.cancel("turn-1", "item-before-enqueue"), { cancelled: true });
  assert.deepEqual(mailbox.enqueue("turn-1", steer("item-before-enqueue")), {
    accepted: false,
    reason: "cancelled",
  });

  mailbox.enqueue("turn-1", steer("item-drained"));
  assert.deepEqual(mailbox.drain("turn-1").map((entry) => entry.itemId), ["item-drained"]);
  assert.deepEqual(mailbox.cancel("turn-1", "item-drained"), {
    cancelled: false,
    reason: "too_late",
  });
});
