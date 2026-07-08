import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentLoop } from "../../src/agent/index.js";
import { TurnRunner } from "../../src/agent/index.js";
import type { AgentTranscriptWriter, AgentStatusMessageInput } from "../../src/session/transcript/TranscriptWriter.js";

test("TurnRunner emits generic turn_failed status for loop-level fallback errors", async () => {
  const fakeLoop = {
    run() {
      return (async function* (): AsyncGenerator<AgentEvent, never, unknown> {
        throw new Error("loop exploded");
      })();
    },
    snapshotForRuntimeReload() {
      return {
        runtimeContext: { cwd: "/tmp", transcriptPath: "" },
      };
    },
    snapshotFileState() {
      return {};
    },
  } as unknown as AgentLoop;

  const recordedStatuses: AgentStatusMessageInput[] = [];
  const transcript: AgentTranscriptWriter = {
    async recordAcceptedInput() {},
    async recordDurableMessage() {},
    async recordAgentStatusMessage(_sessionId, _turnId, status) {
      recordedStatuses.push(status);
    },
    async recordTurnResult() {},
  };
  const runner = new TurnRunner(fakeLoop, transcript, undefined, () => new Date("2026-07-07T00:00:00.000Z"));
  const events: AgentEvent[] = [];
  const generator = runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "hello" },
  });

  while (true) {
    const next = await generator.next();
    if (next.done) break;
    events.push(next.value);
  }

  const statusIndex = events.findIndex((event) =>
    event.type === "agent_status" && event.event === "turn_failed"
  );
  const failedIndex = events.findIndex((event) => event.type === "turn_failed");
  assert.notEqual(statusIndex, -1);
  assert.notEqual(failedIndex, -1);
  assert.ok(statusIndex < failedIndex);
  assert.equal(recordedStatuses[0]?.event, "turn_failed");
  assert.equal(recordedStatuses[0]?.detail?.message, "loop exploded");
  assert.equal(recordedStatuses[0]?.detail?.code, "agent_invalid_state");
  assert.equal(recordedStatuses[0]?.detail?.scope, "turn");
  assert.equal(recordedStatuses[0]?.detail?.source, "agent");
});
