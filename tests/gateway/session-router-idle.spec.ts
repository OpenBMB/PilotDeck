import test from "node:test";
import assert from "node:assert/strict";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function createRouter(): SessionRouter {
  return new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: async () => ({ abort() {}, snapshot: () => ({ messages: [] }) }) as never,
  });
}

test("waitForIdle resolves only after the matching turn slot is released", async () => {
  const router = createRouter();
  assert.equal(router.beginTurn("session-1", "run-1"), true);
  let resolved = false;
  const pending = router.waitForIdle("session-1").then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  router.endTurn("session-1", "other-run");
  assert.equal(resolved, false);
  router.endTurn("session-1", "run-1");
  await pending;
  assert.equal(resolved, true);
  router.shutdown();
});

test("waitForIdle honors AbortSignal without releasing the turn", async () => {
  const router = createRouter();
  router.beginTurn("session-1", "run-1");
  const controller = new AbortController();
  const pending = router.waitForIdle("session-1", { signal: controller.signal });
  controller.abort("cancelled");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(router.isTurnInFlight("session-1"), true);
  router.endTurn("session-1", "run-1");
  router.shutdown();
});
