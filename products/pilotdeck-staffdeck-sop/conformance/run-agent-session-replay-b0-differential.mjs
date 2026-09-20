#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const expected = await runReplay(b0Root);
const actual = await runReplay(candidateRoot);
assert.deepEqual(actual, expected, "Agent session replay differential mismatch");

const expectedResumedExecution = await runResumedExecution(b0Root);
const actualResumedExecution = await runResumedExecution(candidateRoot);
if (process.env.PILOTDECK_DIFFERENTIAL_TEST_INJECT_MISMATCH === "1") {
  actualResumedExecution.modelRequests[0][0].content[0].text = "injected mismatch";
}
assert.deepEqual(
  actualResumedExecution,
  expectedResumedExecution,
  "Agent incomplete-turn resumed-execution differential mismatch",
);

const altered = structuredClone(actual);
altered.messages[0].content[0].text = "changed";
assert.notDeepEqual(altered, actual, "replay comparator sensitivity fixture did not detect changed content");
const alteredResumedExecution = structuredClone(actualResumedExecution);
alteredResumedExecution.modelRequests[0].reverse();
assert.notDeepEqual(
  alteredResumedExecution,
  actualResumedExecution,
  "resume comparator sensitivity fixture did not detect changed model-message order",
);

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: [
    "completed-turn-and-visible-message-replay",
    "compact-boundary-replay",
    "incomplete-message-diagnostic",
    "incomplete-turn-resumed-execution",
  ],
  visibleMessages: actual.messages.length,
  visibleEvents: actual.events.length,
  diagnostics: actual.diagnostics.length,
}, null, 2) + "\n");

async function runReplay(root) {
  const [{ InMemoryTranscriptWriter }, { replayTranscriptEntries }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/session/transcript/InMemoryTranscriptWriter.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/transcript/TranscriptReplay.js")).href),
  ]);

  const transcript = new InMemoryTranscriptWriter({
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    uuid: (() => {
      let next = 0;
      return () => `replay-entry-${++next}`;
    })(),
  });
  const sessionId = "replay-session";
  const firstTurn = "replay-turn-1";
  const secondTurn = "replay-turn-2";
  const user = message("user", "Review the approval policy.");
  const assistant = message("assistant", "I found the approval policy.");
  const summary = message("assistant", "Summary: approval policy reviewed.");
  const continuation = message("user", "Continue with the approval.");

  await transcript.recordAcceptedInput(sessionId, firstTurn, [user]);
  await transcript.recordDurableMessage(sessionId, firstTurn, assistant);
  await transcript.recordTurnResult(sessionId, firstTurn, turnResult(sessionId, firstTurn));
  await transcript.recordControlBoundary(
    sessionId,
    firstTurn,
    {
      kind: "compact",
      subtype: "compact_boundary",
      compactMetadata: {
        compactionId: "replay-compaction-1",
        trigger: "manual",
        preTokens: 1200,
        postTokens: 420,
        messagesSummarized: 2,
        summaryGenerated: true,
      },
    },
  );
  await transcript.recordDurableMessage(sessionId, firstTurn, summary);

  await transcript.recordAcceptedInput(sessionId, secondTurn, [continuation]);
  // An assistant message without a completed turn must not become visible after restore.
  await transcript.recordDurableMessage(sessionId, secondTurn, message("assistant", "incomplete response"));

  const replay = replayTranscriptEntries(transcript.entries);
  return normalize({
    messages: replay.messages,
    events: replay.events,
    diagnostics: replay.diagnostics,
  });
}

async function runResumedExecution(root) {
  const [{ createAgentProjectSessionStorage }, { resumeAgentSession }, { readTranscript }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/session/storage/ProjectSessionStorage.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/resume/resumeAgentSession.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/transcript/TranscriptReader.js")).href),
  ]);
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-agent-replay-differential-"));
  const sessionId = "resumed-execution-session";
  const completedTurn = "completed-turn";
  const interruptedTurn = "interrupted-turn";
  const continuationTurn = "continuation-turn";
  try {
    const storage = createAgentProjectSessionStorage({
      projectRoot: workspace,
      pilotHome: workspace,
      sessionId,
      now: () => new Date("2026-09-19T00:00:00.000Z"),
    });
    await storage.transcript.recordAcceptedInput(sessionId, completedTurn, [message("user", "Original durable request.")]);
    await storage.transcript.recordDurableMessage(sessionId, completedTurn, message("assistant", "Original durable response."));
    await storage.transcript.recordTurnResult(sessionId, completedTurn, turnResult(sessionId, completedTurn));
    await storage.transcript.recordAcceptedInput(sessionId, interruptedTurn, [message("user", "Interrupted request must remain visible." )]);
    await storage.transcript.recordDurableMessage(sessionId, interruptedTurn, message("assistant", "Incomplete stream must not replay."));
    await storage.dispose?.();

    const modelRequests = [];
    const resumed = await resumeAgentSession({
      sessionId,
      projectStorage: { projectRoot: workspace, pilotHome: workspace },
      config: sessionConfig(workspace),
      collectFileArtifacts: false,
      dependencies: sessionDependencies(modelRequests),
    });
    const events = [];
    for await (const event of resumed.session.submit(
      { type: "text", text: "Continue from the interrupted request." },
      { turnId: continuationTurn, maxTurns: 1 },
    )) events.push(event);
    await resumed.handle?.dispose?.("differential_cleanup");

    const transcript = await readTranscript(resumed.transcriptPath);
    return normalize({
      diagnostics: resumed.diagnostics,
      modelRequests: modelRequests.map((request) => request.messages),
      events: events.map((event) => ({
        type: event.type,
        ...(event.type === "turn_completed" ? { result: semanticTurnResult(event.result) } : {}),
        ...(event.type === "turn_failed" ? { error: event.error } : {}),
      })),
      durableSemanticEventTypes: transcript.entries
        .filter((entry) => ["accepted_input", "assistant_message", "tool_result_message", "durable_message", "turn_result"].includes(entry.type))
        .map((entry) => entry.type),
      durableToolResultCount: transcript.entries.filter((entry) => entry.type === "tool_result_message").length,
      terminal: transcript.entries.at(-1)?.type === "turn_result"
        ? semanticTurnResult(transcript.entries.at(-1).result)
        : undefined,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function message(role, text) {
  return { role, content: [{ type: "text", text }] };
}

function turnResult(sessionId, turnId) {
  return {
    type: "success",
    sessionId,
    turnId,
    stopReason: "completed",
    usage: { inputTokens: 12, outputTokens: 4 },
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-19T00:00:00.000Z",
    completedAt: "2026-09-19T00:00:01.000Z",
  };
}

function sessionConfig(cwd) {
  return {
    provider: "test",
    model: "test",
    cwd,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function sessionDependencies(modelRequests) {
  const stream = async function* () {
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "Recovered continuation response." };
    yield { type: "message_end", finishReason: "stop" };
  };
  return {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
      async decide({ request }) {
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "explicit",
          mutations: {},
        };
      },
      materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
      async *execute(_decision, request) {
        modelRequests.push(structuredClone(request));
        yield* stream();
      },
    },
    context: {
      async prepareForModel(input) {
        return {
          messages: input.messages,
          systemPromptParts: [],
          tools: input.tools,
          diagnostics: [],
          boundaries: [],
        };
      },
    },
    tools: { registry: { list: () => [] } },
    ports: {
      model: {
        async prepare({ request }) {
          modelRequests.push(structuredClone(request));
          return { request, provider: request.provider, model: request.model };
        },
        stream,
      },
    },
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    uuid: () => "resumed-execution-id",
  };
}

function semanticTurnResult(result) {
  return {
    type: result.type,
    stopReason: result.stopReason,
    usage: result.usage,
    permissionDenials: result.permissionDenials,
    turns: result.turns,
    ...(result.finalMessage
      ? {
          finalMessage: {
            role: result.finalMessage.role,
            content: result.finalMessage.content.map((block) => ({
              type: block.type,
              ...(block.type === "text" ? { text: block.text } : {}),
            })),
          },
        }
      : {}),
    ...(result.errors ? { errors: result.errors } : {}),
  };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
}
