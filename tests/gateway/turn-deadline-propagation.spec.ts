import assert from "node:assert/strict";
import test from "node:test";

import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("Gateway propagates its absolute turn deadline into the Agent session", async () => {
  let submitted: AgentSubmitOptions | undefined;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => ({
      async *submit(_input: AgentInput, options: AgentSubmitOptions = {}) {
        submitted = options;
        const turnId = options.turnId ?? "turn-1";
        yield {
          type: "turn_completed",
          sessionId: "session-1",
          turnId,
          result: {
            type: "success",
            sessionId: "session-1",
            turnId,
            stopReason: "completed",
            usage: {},
            permissionDenials: [],
            turns: 1,
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:00.000Z",
          },
        };
      },
      abort() {},
      snapshot() {
        return { sessionId: "session-1", messages: [], usage: {}, status: "idle", permissionDenials: [] };
      },
    }) as unknown as AgentSession,
  });
  const gateway = new InProcessGateway(router, { uuid: () => "run-1" });
  const beforeMs = Date.now();

  for await (const _event of gateway.submitTurn({
    sessionKey: "session-1",
    channelKey: "cli",
    message: "bounded task",
    timeoutMs: 60_000,
  })) {
    // Drain the Gateway turn.
  }
  const afterMs = Date.now();

  assert.ok(submitted?.turnDeadlineAtMs);
  assert.ok(submitted.turnDeadlineAtMs >= beforeMs + 60_000);
  assert.ok(submitted.turnDeadlineAtMs <= afterMs + 60_000);
  router.shutdown();
});
