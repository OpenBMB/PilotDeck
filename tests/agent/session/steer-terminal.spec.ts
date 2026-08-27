import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopRunResult,
} from "../../../src/agent/loop/AgentLoop.js";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { TurnRunner } from "../../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

test("terminal turns return accepted but unapplied guidance before completion", async () => {
  const result: AgentTurnResult = {
    type: "max_turns",
    sessionId: "session-1",
    turnId: "turn-1",
    stopReason: "max_turns",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:01.000Z",
  };
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: "test-model",
        provider: "test-provider",
      };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    new InMemoryTranscriptWriter(),
    undefined,
    () => new Date("2026-08-26T00:00:01.000Z"),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
  );
  const session = new AgentSession({
    sessionId: "session-1",
    turnRunner: runner,
    uuid: () => "turn-1",
  });
  const stream = session.submit({ type: "text", text: "Start" });

  let current = await stream.next();
  while (!current.done && current.value.type !== "model_request_started") {
    current = await stream.next();
  }
  assert.equal(current.done, false);
  assert.deepEqual(session.steer({
    turnId: "turn-1",
    itemId: "queue-1",
    message: {
      role: "user",
      content: [{ type: "text", text: "Adjust direction" }],
    },
  }), { accepted: true });

  const unapplied = await stream.next();
  assert.equal(unapplied.done, false);
  assert.equal(unapplied.value?.type, "steer_unapplied");
  assert.equal(unapplied.value?.type === "steer_unapplied" ? unapplied.value.itemId : undefined, "queue-1");
  assert.deepEqual(session.steer({
    turnId: "turn-1",
    itemId: "queue-2",
    message: {
      role: "user",
      content: [{ type: "text", text: "Too late" }],
    },
  }), { accepted: false, reason: "turn_closing" });

  const completed = await stream.next();
  assert.equal(completed.value?.type, "turn_completed");
  const ended = await stream.next();
  assert.equal(ended.value?.type, "session_ended");
  assert.equal((await stream.next()).done, true);
});

test("a partially persisted guidance batch applies only durable messages and returns the rest", async () => {
  class FailingSteerTranscript extends InMemoryTranscriptWriter {
    override recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void {
      if (message.metadata?.queueItemId === "queue-2") throw new Error("transcript unavailable");
      super.recordDurableMessage(sessionId, turnId, message);
    }
  }

  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      yield {
        type: "model_request_started",
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: "test-model",
        provider: "test-provider",
      };
      for (const guidance of input.drainSteerMessages?.() ?? []) {
        await input.onDurableMessage?.(guidance.message);
        input.onSteerApplied?.(guidance.itemId);
        yield {
          type: "steer_applied",
          sessionId: input.sessionId,
          turnId: input.turnId,
          itemId: guidance.itemId,
          message: guidance.message,
        };
      }
      assert.fail("the transcript write should stop the loop");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    new FailingSteerTranscript(),
    undefined,
    () => new Date("2026-08-26T00:00:01.000Z"),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
  );
  const session = new AgentSession({ sessionId: "session-1", turnRunner: runner, uuid: () => "turn-1" });
  const stream = session.submit({ type: "text", text: "Start" });

  let current = await stream.next();
  while (!current.done && current.value.type !== "model_request_started") current = await stream.next();
  assert.deepEqual(session.steer({
    turnId: "turn-1",
    itemId: "queue-1",
    message: {
      role: "user",
      content: [{ type: "text", text: "Adjust direction" }],
      metadata: { queueItemId: "queue-1" },
    },
  }), { accepted: true });
  assert.deepEqual(session.steer({
    turnId: "turn-1",
    itemId: "queue-2",
    message: {
      role: "user",
      content: [{ type: "text", text: "Then use CSS" }],
      metadata: { queueItemId: "queue-2" },
    },
  }), { accepted: true });

  const remaining: AgentEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  const remainingTypes = remaining.map((event) => event.type);
  assert.deepEqual(
    remaining.filter((event) => event.type === "steer_applied").map((event) => event.itemId),
    ["queue-1"],
  );
  assert.deepEqual(
    remaining.filter((event) => event.type === "steer_unapplied").map((event) => event.itemId),
    ["queue-2"],
  );
  assert.ok(remainingTypes.includes("turn_failed"));
  assert.ok(remainingTypes.indexOf("steer_unapplied") > remainingTypes.indexOf("turn_failed"));
  assert.ok(remainingTypes.indexOf("steer_unapplied") < remainingTypes.indexOf("turn_completed"));
  assert.deepEqual(
    session.snapshot().messages
      .map((message) => message.metadata?.queueItemId)
      .filter((itemId): itemId is string => typeof itemId === "string"),
    ["queue-1"],
  );
});
