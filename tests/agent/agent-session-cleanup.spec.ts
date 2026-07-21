import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../../src/agent/session/AgentSession.js";

test("AgentSession restores terminal state and dispatches SessionEnd when the runner throws", async () => {
  const events: string[] = [];
  const session = new AgentSession({
    sessionId: "session-1",
    turnRunner: {
      async *run() {
        throw new Error("runner failed");
      },
    } as never,
    lifecycle: {
      async dispatch(input: { event: string }) {
        events.push(input.event);
        return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
      },
    } as never,
  });

  await assert.rejects(async () => {
    for await (const _event of session.submit({ type: "text", text: "hello" })) {
      // Drain the generator so its cleanup contract is exercised.
    }
  }, /runner failed/);

  assert.equal(session.snapshot().status, "failed");
  assert.equal(session.snapshot().currentTurnId, undefined);
  assert.deepEqual(events, ["SessionStart", "Setup", "SessionEnd"]);
});

test("AgentSession cleanup runs when a consumer stops reading early", async () => {
  const events: string[] = [];
  const session = new AgentSession({
    sessionId: "session-1",
    turnRunner: {
      async *run() {
        yield { type: "warning", sessionId: "session-1", turnId: "turn", code: "test", message: "pause" };
        return {
          result: { type: "success", usage: {}, permissionDenials: [] },
          messages: [],
        };
      },
    } as never,
    lifecycle: {
      async dispatch(input: { event: string }) {
        events.push(input.event);
        return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
      },
    } as never,
  });

  for await (const event of session.submit({ type: "text", text: "hello" })) {
    if (event.type === "session_started") break;
  }

  assert.equal(session.snapshot().status, "failed");
  assert.equal(session.snapshot().currentTurnId, undefined);
  assert.deepEqual(events, ["SessionEnd"]);
});
