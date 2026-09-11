import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileGatewayUserDialogStore } from "../../src/gateway/user-dialog/FileGatewayUserDialogStore.js";
import type {
  GatewayStoredUserDialog,
  GatewayUserDialogStoreKey,
} from "../../src/gateway/user-dialog/GatewayUserDialogStore.js";

const key: GatewayUserDialogStoreKey = {
  projectRoot: "/workspace/project",
  pilotHome: "/workspace/home",
  sessionId: "sdk:file-dialog-store",
};

const dialog: GatewayStoredUserDialog = {
  request: {
    type: "user_dialog_request",
    requestId: "dialog-1",
    dialogKind: "input",
    toolCallId: "tool-1",
    toolName: "request_user_input",
    prompt: "Which command should I run?",
  },
  createdAt: "2026-09-11T00:00:00.000Z",
};

test("file user-dialog store persists and atomically hands a live answer between Gateway instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-dialog-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const now = new Date("2026-09-11T00:00:00.000Z");
  const options = { directory: root, now: () => now };
  const first = new FileGatewayUserDialogStore(options);
  const second = new FileGatewayUserDialogStore(options);
  await first.put(key, dialog);

  assert.deepEqual(await second.list(key), [dialog], "a second process sees the durable pending request");

  const claims = await Promise.all([
    first.claimLive(key, { requestId: dialog.request.requestId, ttlMs: 1_000 }),
    second.claimLive(key, { requestId: dialog.request.requestId, ttlMs: 1_000 }),
  ]);
  const winners = claims.filter((claim): claim is { claimed: true; leaseId: string; expiresAt: string } => claim.claimed);
  assert.equal(winners.length, 1);
  const winner = winners[0]!;
  const loser = claims.find((claim) => !claim.claimed);
  assert.deepEqual(loser, { claimed: false, reason: "claimed", expiresAt: winner.expiresAt });

  assert.equal(await second.submitLiveAnswer(key, {
    requestId: dialog.request.requestId,
    leaseId: "another-renderer",
    result: { behavior: "answered", value: "pnpm test" },
  }), false, "a renderer without the lease cannot answer");
  assert.equal(await second.submitLiveAnswer(key, {
    requestId: dialog.request.requestId,
    leaseId: winner.leaseId,
    result: { behavior: "answered", value: "pnpm test" },
  }), true);

  assert.deepEqual(await first.takeLiveAnswer(key, dialog.request.requestId), {
    requestId: dialog.request.requestId,
    result: { behavior: "answered", value: "pnpm test" },
    submittedAt: now.toISOString(),
  });
  assert.equal(await second.takeLiveAnswer(key, dialog.request.requestId), undefined, "answers are consumed exactly once");

  await first.remove(key, dialog.request.requestId);
  assert.deepEqual(await second.list(key), []);
});

test("file user-dialog store lets a new renderer claim an expired lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-dialog-store-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let now = new Date("2026-09-11T00:00:00.000Z");
  let id = 0;
  const options = {
    directory: root,
    now: () => now,
    uuid: () => `lease-${++id}`,
  };
  const first = new FileGatewayUserDialogStore(options);
  const second = new FileGatewayUserDialogStore(options);
  await first.put(key, dialog);

  const initial = await first.claimLive(key, { requestId: dialog.request.requestId, ttlMs: 1_000 });
  assert.equal(initial.claimed, true);
  now = new Date("2026-09-11T00:00:01.001Z");
  const replacement = await second.claimLive(key, { requestId: dialog.request.requestId, ttlMs: 1_000 });
  assert.equal(replacement.claimed, true);
  assert.notEqual(replacement.leaseId, initial.leaseId);
  assert.equal(await first.releaseLive(key, {
    requestId: dialog.request.requestId,
    leaseId: initial.leaseId,
  }), false);
  assert.equal(await second.releaseLive(key, {
    requestId: dialog.request.requestId,
    leaseId: replacement.leaseId,
  }), true);
});

test("file user-dialog store stops projecting a dialog as live after its owner heartbeat expires", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-file-dialog-store-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let now = new Date("2026-09-11T00:00:00.000Z");
  const store = new FileGatewayUserDialogStore({
    directory: root,
    now: () => now,
    uuid: () => "owner-1",
  });
  await store.put(key, dialog);
  assert.deepEqual(await store.claimLiveOwner(key, {
    requestId: dialog.request.requestId,
    ownerId: "gateway-owner",
    ttlMs: 1_000,
  }), {
    owned: true,
    ownerId: "gateway-owner",
    expiresAt: "2026-09-11T00:00:01.000Z",
  });
  assert.deepEqual(await store.listLive(key), [dialog]);

  now = new Date("2026-09-11T00:00:01.001Z");
  assert.deepEqual(await store.listLive(key), [], "a dead owner is not offered to another renderer as a live turn");
  assert.deepEqual(await store.list(key), [dialog], "the durable record remains available to restart recovery");
  assert.equal(await store.renewLiveOwner(key, {
    requestId: dialog.request.requestId,
    ownerId: "gateway-owner",
    ttlMs: 1_000,
  }), false);
});
