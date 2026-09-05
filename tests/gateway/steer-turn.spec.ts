import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("gateway turns guidance and uploaded attachments into a canonical user message for the active run", async () => {
  let received: {
    turnId: string;
    itemId: string;
    message: CanonicalMessage;
    allowedReadFiles?: string[];
  } | undefined;
  let cancelled: { turnId: string; itemId: string } | undefined;
  const session = {
    steer(input: typeof received) {
      received = input;
      return { accepted: true } as const;
    },
    cancelSteer(input: typeof cancelled) {
      cancelled = input;
      return { cancelled: true } as const;
    },
    abort() {},
    snapshot() {
      return { sessionId: "session-1", messages: [], usage: {}, status: "running", permissionDenials: [] };
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => session,
  });
  await router.getOrCreate({ sessionKey: "session-1", channelKey: "web" });
  assert.equal(router.beginTurn("session-1", "run-1"), true);

  const gateway = new InProcessGateway(router, {
    resolveUploadedAttachments: async ({ projectKey, uploads }) => {
      assert.equal(projectKey, "/tmp/project");
      assert.deepEqual(uploads, [{ uploadId: "upload-1", attachmentIds: ["file-1"] }]);
      return [{
        type: "text",
        name: "report.pdf",
        content: "uploaded report content",
        source: "media_reference",
      }];
    },
  });
  const result = await gateway.steerTurn({
    sessionKey: "session-1",
    runId: "run-1",
    itemId: "queue-1",
    message: "Use HTML instead",
    projectKey: "/tmp/project",
    uploadedAttachments: [{ uploadId: "upload-1", attachmentIds: ["file-1"] }],
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(received?.turnId, "run-1");
  assert.equal(received?.itemId, "queue-1");
  assert.equal(received?.message.role, "user");
  assert.deepEqual(received?.message.metadata, {
    purpose: "mid_turn_steer",
    queueItemId: "queue-1",
  });
  assert.equal(received?.message.content.some((part) => (
    part.type === "text" && part.text.includes("Use HTML instead")
  )), true);
  assert.equal(received?.message.content.some((part) => (
    part.type === "text" && part.text.includes("uploaded report content")
  )), true);

  assert.deepEqual(await gateway.steerTurn({
    sessionKey: "session-1",
    runId: "stale-run",
    itemId: "queue-2",
    message: "stale",
  }), { accepted: false, reason: "turn_mismatch" });

  assert.deepEqual(await gateway.cancelSteer({
    sessionKey: "session-1",
    runId: "run-1",
    itemId: "queue-1",
  }), { cancelled: true });
  assert.deepEqual(cancelled, { turnId: "run-1", itemId: "queue-1" });

  assert.deepEqual(await gateway.cancelSteer({
    sessionKey: "session-1",
    runId: "stale-run",
    itemId: "queue-1",
  }), { cancelled: false, reason: "turn_mismatch" });
});
