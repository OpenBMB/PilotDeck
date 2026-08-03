import test from "node:test";
import assert from "node:assert/strict";
import type { AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("internal prompt dispatch waits for the user turn and fully drains the synthetic turn", async () => {
  const submissions: Array<{ input: AgentInput; options: AgentSubmitOptions }> = [];
  let generatorCleanedUp = false;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => ({
      async *submit(input: AgentInput, options: AgentSubmitOptions = {}) {
        submissions.push({ input, options });
        const turnId = options.turnId ?? "internal-turn";
        try {
          yield { type: "turn_started", sessionId: "session-1", turnId };
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
              startedAt: "2026-07-22T00:00:00.000Z",
              completedAt: "2026-07-22T00:00:00.000Z",
            },
          };
        } finally {
          generatorCleanedUp = true;
        }
      },
      abort() {},
      snapshot() {
        return { sessionId: "session-1", messages: [], usage: {}, status: "idle", permissionDenials: [] };
      },
    }) as unknown as AgentSession,
  });
  const gateway = new InProcessGateway(router, {
    uuid: (() => {
      let sequence = 0;
      return () => `generated-${++sequence}`;
    })(),
  });

  assert.equal(router.beginTurn("session-1", "user-turn"), true);
  const pending = gateway.getInternalPromptDispatcher().dispatch({
    sessionKey: "session-1",
    prompt: "Continue the bounded maintenance task.",
    source: "goal-monitor",
    dedupeKey: "goal-1:checkpoint-2",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submissions.length, 0);

  router.endTurn("session-1", "user-turn");
  const result = await pending;

  assert.equal(result.status, "completed");
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0]?.input, {
    type: "text",
    text: "Continue the bounded maintenance task.",
    isMeta: true,
  });
  assert.equal(submissions[0]?.options.canPrompt, false);
  assert.equal(generatorCleanedUp, true);
  assert.equal(router.isTurnInFlight("session-1"), false);
  router.shutdown();
});
