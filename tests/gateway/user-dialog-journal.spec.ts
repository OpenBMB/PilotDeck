import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GatewayUserDialogJournal } from "../../src/gateway/user-dialog/GatewayUserDialogJournal.js";
import type { GatewayUserDialogRequestEvent } from "../../src/gateway/protocol/types.js";

const request: GatewayUserDialogRequestEvent = {
  type: "user_dialog_request",
  requestId: "dialog-1",
  dialogKind: "input",
  toolCallId: "tool-1",
  toolName: "request_user_input",
  prompt: "Which test command should I run?",
  placeholder: "pnpm test",
};

test("user-dialog journal retains a pending request until recovery settles it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-dialog-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new GatewayUserDialogJournal(join(root, "session.jsonl.dialogs.json"), {
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  });

  journal.record(request);
  assert.deepEqual(journal.recover(), [{
    type: "user_dialog_terminated",
    request,
    reason: "gateway_restarted",
    terminatedAt: "2026-09-10T00:00:00.000Z",
    recovery: "next_turn_context",
  }]);
  assert.deepEqual(journal.recover(), [{
    type: "user_dialog_terminated",
    request,
    reason: "gateway_restarted",
    terminatedAt: "2026-09-10T00:00:00.000Z",
    recovery: "next_turn_context",
  }]);
  journal.remove(request.requestId);
  assert.deepEqual(journal.recover(), []);
});

test("user-dialog journal removes a normally settled request before recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-user-dialog-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new GatewayUserDialogJournal(join(root, "session.jsonl.dialogs.json"));

  journal.record(request);
  journal.remove(request.requestId);
  assert.deepEqual(journal.recover(), []);
});
