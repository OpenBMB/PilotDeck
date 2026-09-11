import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileGatewayUserDialogStore,
  HttpGatewayUserDialogStore,
  startGatewayUserDialogStoreHttpServer,
} from "../../src/gateway/index.js";
import type {
  GatewayStoredUserDialog,
  GatewayUserDialogStoreKey,
} from "../../src/gateway/user-dialog/GatewayUserDialogStore.js";

const key: GatewayUserDialogStoreKey = {
  projectRoot: "/workspace/project",
  pilotHome: "/workspace/home",
  sessionId: "sdk:http-dialog-store",
};

const dialog: GatewayStoredUserDialog = {
  request: {
    type: "user_dialog_request",
    requestId: "http-dialog-1",
    dialogKind: "form",
    toolCallId: "tool-1",
    toolName: "request_user_form",
    prompt: "Configure the deployment.",
    schema: {
      type: "object",
      properties: { region: { type: "string" } },
      required: ["region"],
      additionalProperties: false,
    },
  },
  createdAt: "2026-09-11T00:00:00.000Z",
};

test("HTTP user-dialog store supports a complete durable multi-host live protocol", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-http-dialog-store-"));
  const token = "test-dialog-store-token";
  const server = await startGatewayUserDialogStoreHttpServer({
    store: new FileGatewayUserDialogStore({ directory: root }),
    authorizationToken: token,
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = new HttpGatewayUserDialogStore({ url: server.url, authorizationToken: token });
  const second = new HttpGatewayUserDialogStore({ url: server.url, authorizationToken: token });
  const unauthorized = new HttpGatewayUserDialogStore({ url: server.url, authorizationToken: "wrong-token" });

  await first.put(key, dialog);
  assert.deepEqual(await second.list(key), [dialog]);
  await assert.rejects(() => unauthorized.list(key), /authorization failed/);

  const owner = await first.claimLiveOwner(key, {
    requestId: dialog.request.requestId,
    ownerId: "gateway-a",
    ttlMs: 5_000,
  });
  assert.equal(owner.owned, true);
  assert.deepEqual(await second.listLive(key), [dialog]);
  assert.equal(await first.renewLiveOwner(key, {
    requestId: dialog.request.requestId,
    ownerId: "gateway-a",
    ttlMs: 5_000,
  }), true);

  const claim = await second.claimLive(key, {
    requestId: dialog.request.requestId,
    ttlMs: 5_000,
  });
  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Expected the renderer lease to be claimed.");
  assert.equal(await first.submitLiveAnswer(key, {
    requestId: dialog.request.requestId,
    leaseId: "wrong-lease",
    result: { behavior: "answered", value: { region: "us-east-1" } },
  }), false);
  assert.equal(await second.submitLiveAnswer(key, {
    requestId: dialog.request.requestId,
    leaseId: claim.leaseId,
    result: { behavior: "answered", value: { region: "us-east-1" } },
  }), true);
  const answer = await first.takeLiveAnswer(key, dialog.request.requestId);
  assert.deepEqual(answer && {
    requestId: dialog.request.requestId,
    result: { behavior: "answered", value: { region: "us-east-1" } },
  }, {
    requestId: dialog.request.requestId,
    result: { behavior: "answered", value: { region: "us-east-1" } },
  });
  assert.equal(typeof answer?.submittedAt, "string");
  assert.equal(await second.takeLiveAnswer(key, dialog.request.requestId), undefined);

  assert.equal(await first.releaseLive(key, {
    requestId: dialog.request.requestId,
    leaseId: claim.leaseId,
  }), true);
  assert.equal(await second.releaseLiveOwner(key, {
    requestId: dialog.request.requestId,
    ownerId: "gateway-a",
  }), true);
  assert.deepEqual(await first.listLive(key), []);
  await first.clear(key);
  assert.deepEqual(await second.list(key), []);
});
