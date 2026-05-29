import test from "node:test";
import assert from "node:assert/strict";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { AgentEvent } from "../../src/agent/index.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";

test("InProcessGateway aborts the running turn when the consumer closes early", async () => {
  let abortCalled = false;
  let endTurnCalled = false;
  let releaseSubmit: (() => void) | undefined;

  const router = {
    beginTurn: () => true,
    getOrCreate: async () => ({
      submit: async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "turn_started", sessionId: "s", turnId: "r" };
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
      },
      abort: () => undefined,
      snapshot: () => ({
        sessionId: "s",
        messages: [],
        usage: {},
        permissionDenials: [],
        status: "idle",
      }),
    }),
    abort: async () => {
      abortCalled = true;
      releaseSubmit?.();
    },
    endTurn: () => {
      endTurnCalled = true;
    },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router);
  const iterator = gateway.submitTurn({
    sessionKey: "s",
    channelKey: "web",
    message: "hello",
    runId: "r",
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.type, "turn_started");

  await iterator.return?.();

  assert.equal(abortCalled, true);
  assert.equal(endTurnCalled, true);
});
