import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("TurnRunner emits and persists file artifacts before completing the turn", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-turn-artifacts-"));
  try {
    const result: AgentTurnResult = {
      type: "success",
      sessionId: "session-1",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-21T10:00:00.000Z",
      completedAt: "2026-07-21T10:00:01.000Z",
    };
    const fakeLoop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        await mkdir(join(projectRoot, "app"), { recursive: true });
        await writeFile(join(projectRoot, "app", "page.tsx"), "export default function Page() {}\n");
        await writeFile(join(projectRoot, "app", "globals.css"), "body { margin: 0; }\n");
        await mkdir(join(projectRoot, ".pilotdeck", "work", input.sessionId, input.turnId), { recursive: true });
        await writeFile(
          join(projectRoot, ".pilotdeck", "work", input.sessionId, input.turnId, "builder.mjs"),
          "// internal\n",
        );
        yield {
          type: "tool_result",
          sessionId: input.sessionId,
          turnId: input.turnId,
          result: {
            type: "success",
            toolCallId: "bash-1",
            toolName: "bash",
            content: [{ type: "text", text: "created files" }],
            startedAt: "2026-07-21T10:00:00.000Z",
            completedAt: "2026-07-21T10:00:00.500Z",
          },
        };
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages: input.messages };
      },
      snapshotFileState: () => ({}),
    } as unknown as AgentLoop;
    const transcript = new InMemoryTranscriptWriter();
    const runner = new TurnRunner(
      fakeLoop,
      transcript,
      undefined,
      () => new Date("2026-07-21T10:00:01.000Z"),
      undefined,
      { cwd: projectRoot, transcriptPath: "" },
    );

    const eventTypes: string[] = [];
    for await (const event of runner.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [],
      input: { type: "text", text: "Create a workbook" },
    })) {
      eventTypes.push(event.type);
    }

    assert.ok(eventTypes.indexOf("file_artifacts") > -1);
    assert.ok(eventTypes.indexOf("file_artifacts") < eventTypes.indexOf("turn_completed"));
    const artifactEntryIndex = transcript.entries.findIndex((entry) => entry.type === "file_artifacts");
    const resultEntryIndex = transcript.entries.findIndex((entry) => entry.type === "turn_result");
    assert.ok(artifactEntryIndex > -1);
    assert.ok(artifactEntryIndex < resultEntryIndex);
    const artifactEntry = transcript.entries[artifactEntryIndex];
    assert.deepEqual(
      artifactEntry.type === "file_artifacts"
        ? artifactEntry.artifacts.map((artifact) => artifact.path)
        : undefined,
      ["app/globals.css", "app/page.tsx"],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("TurnRunner does not collect generated files when artifacts are disabled", async () => {
  const generalRoot = await mkdtemp(join(tmpdir(), "pilotdeck-general-no-artifacts-"));
  try {
    const result: AgentTurnResult = {
      type: "success",
      sessionId: "general-session",
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-07-22T10:00:00.000Z",
      completedAt: "2026-07-22T10:00:01.000Z",
    };
    const fakeLoop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        await writeFile(join(generalRoot, "generated.md"), "# Generated in general chat\n");
        await writeFile(join(generalRoot, `${input.sessionId}.jsonl`), '{"type":"turn_result"}\n');
        yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
        return { result, messages: input.messages };
      },
      snapshotFileState: () => ({}),
    } as unknown as AgentLoop;
    const transcript = new InMemoryTranscriptWriter();
    const runner = new TurnRunner(
      fakeLoop,
      transcript,
      undefined,
      () => new Date("2026-07-22T10:00:01.000Z"),
      undefined,
      { cwd: generalRoot, transcriptPath: "", collectFileArtifacts: false },
    );

    const eventTypes: string[] = [];
    for await (const event of runner.run({
      sessionId: "general-session",
      turnId: "turn-1",
      messages: [],
      input: { type: "text", text: "你好" },
    })) {
      eventTypes.push(event.type);
    }

    assert.equal(eventTypes.includes("file_artifacts"), false);
    assert.equal(transcript.entries.some((entry) => entry.type === "file_artifacts"), false);
  } finally {
    await rm(generalRoot, { recursive: true, force: true });
  }
});

test("TurnRunner persists compact boundary before post-compact replacement messages", async () => {
  const result: AgentTurnResult = {
    type: "success",
    sessionId: "compact-session",
    turnId: "turn-1",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-08-02T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:01.000Z",
  };
  const fakeLoop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      await input.onCompactPersisted?.({
        boundary: {
          kind: "compact",
          subtype: "compact_boundary",
          compactMetadata: {
            trigger: "auto",
            preTokens: 120,
            postTokens: 40,
            messagesSummarized: 2,
          },
        },
        messages: [
          {
            role: "assistant",
            metadata: { compactReplacement: true },
            content: [{ type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\nsummary" }],
          },
          {
            role: "user",
            metadata: { compactReplacement: true },
            content: [{ type: "text", text: "kept tail" }],
          },
        ],
      });
      yield { type: "turn_continued", sessionId: input.sessionId, turnId: input.turnId, reason: "auto_compact" };
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result };
      return { result, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const transcript = new InMemoryTranscriptWriter();
  const runner = new TurnRunner(
    fakeLoop,
    transcript,
    undefined,
    () => new Date("2026-08-02T00:00:01.000Z"),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
  );

  for await (const _event of runner.run({
    sessionId: "compact-session",
    turnId: "turn-1",
    messages: [{ role: "assistant", content: [{ type: "text", text: "old context" }] }],
    input: { type: "text", text: "continue" },
  })) {
    // Drain the runner.
  }

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "accepted_input",
    "control_boundary",
    "durable_message",
    "durable_message",
    "turn_result",
  ]);
  const boundary = transcript.entries[1];
  assert.equal(boundary?.type, "control_boundary");
  assert.equal(
    boundary?.type === "control_boundary" &&
      "subtype" in boundary.boundary &&
      boundary.boundary.subtype === "compact_boundary"
      ? boundary.boundary.compactMetadata.postTokens
      : undefined,
    40,
  );
  const replacementEntries = transcript.entries.slice(2, 4);
  assert.equal(
    replacementEntries.every((entry) =>
      entry.type === "durable_message" && entry.message.metadata?.compactReplacement === true,
    ),
    true,
  );
});
