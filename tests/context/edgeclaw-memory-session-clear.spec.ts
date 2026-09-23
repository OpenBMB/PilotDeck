import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EdgeClawMemoryService } from "edgeclaw-memory-core";

test("EdgeClaw memory can wipe one session without clearing another session's pending capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-memory-session-clear-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new EdgeClawMemoryService({ workspaceDir: root, rootDir: root });
  t.after(() => service.close());

  service.captureTurn([{ role: "user", content: "session one" }], { sessionKey: "session-one" });
  service.captureTurn([{ role: "user", content: "session two" }], { sessionKey: "session-two" });
  const result = service.clearSession("session-one");

  assert.equal(result.scope, "session");
  assert.equal(result.cleared.l0Sessions, 1);
  assert.equal(service.repository.listUnindexedL0BySession("session-one").length, 0);
  assert.equal(service.repository.listUnindexedL0BySession("session-two").length, 1);
});
