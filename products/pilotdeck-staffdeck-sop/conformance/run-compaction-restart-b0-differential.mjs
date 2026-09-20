#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]);
  process.exit(0);
}

const baseline = runWorker(b0Root);
const candidate = runWorker(candidateRoot);
assert.deepEqual(candidate, baseline, "Compaction restart/replay differential mismatch");

const altered = structuredClone(candidate);
altered.completed.messages[0] = "changed summary";
assert.notDeepEqual(altered, candidate, "comparator sensitivity fixture did not detect replay content change");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: [
    "completed-manual-replacement-survives-fresh-process-replay",
    "crash-tail-does-not-expose-uncommitted-replacement",
    "summary-failure-preserves-prior-history",
  ],
  compared: 3,
  result: candidate,
}, null, 2) + "\n");

function runWorker(root) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--worker", root],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`${root} worker failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function worker(root) {
  const { readTranscript } = await import(
    pathToFileURL(join(root, "dist/src/session/transcript/TranscriptReader.js")).href,
  );
  const { replayTranscriptEntries } = await import(
    pathToFileURL(join(root, "dist/src/session/transcript/TranscriptReplay.js")).href,
  );

  const rootDir = await mkdtemp(join(tmpdir(), "pilotdeck-compaction-restart-"));
  try {
    const completedPath = join(rootDir, "completed.jsonl");
    await writeEntries(completedPath, completedEntries());
    // This worker is a fresh process; readTranscript models reopening the
    // durable JSONL after the previous process exited.
    const completedReplay = replayTranscriptEntries((await readTranscript(completedPath)).entries);

    const crashPath = join(rootDir, "crash.jsonl");
    await writeEntries(crashPath, crashTailEntries());
    const crashReplay = replayTranscriptEntries((await readTranscript(crashPath)).entries);

    const failurePath = join(rootDir, "failure.jsonl");
    await writeEntries(failurePath, failureEntries());
    const failureReplay = replayTranscriptEntries((await readTranscript(failurePath)).entries);

    process.stdout.write(JSON.stringify({
      completed: project(completedReplay),
      crash: project(crashReplay),
      failure: project(failureReplay),
    }));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function writeEntries(path, entries) {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function project(replay) {
  return {
    messages: replay.messages.map(messageText),
    lastCompactBoundaryIndex: replay.lastCompactBoundaryIndex ?? null,
    diagnostics: replay.diagnostics.map((item) => ({ code: item.code, severity: item.severity })),
  };
}

function base(type, sequence, turnId) {
  return {
    type,
    sessionId: "session-compaction-restart",
    turnId,
    sequence,
    createdAt: "2026-09-19T00:00:00.000Z",
    entryId: `entry-${sequence}`,
  };
}

function completedEntries() {
  return [
    { ...base("accepted_input", 1, "turn-old"), messages: [message("user", "old history")] },
    { ...base("assistant_message", 2, "turn-old"), message: message("assistant", "old reply") },
    { ...base("turn_result", 3, "turn-old"), result: turnResult("turn-old") },
    {
      ...base("control_boundary", 4, "turn-manual"),
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 100, postTokens: 20, messagesSummarized: 2 },
      },
    },
    { ...base("assistant_message", 5, "turn-manual"), message: message("assistant", "manual summary") },
    { ...base("durable_message", 6, "turn-manual"), message: message("user", "latest tail") },
    { ...base("turn_result", 7, "turn-manual"), result: turnResult("turn-manual") },
  ];
}

function crashTailEntries() {
  return [
    ...completedEntries().slice(0, 3),
    {
      ...base("control_boundary", 4, "turn-crash"),
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 100, postTokens: 20, messagesSummarized: 2 },
      },
    },
  ];
}

function failureEntries() {
  return [
    ...completedEntries().slice(0, 3),
    { ...base("compaction_started", 4, "turn-failure"), operationId: "op-failure", trigger: "manual", messageCount: 2 },
    { ...base("compaction_failed", 5, "turn-failure"), operationId: "op-failure", trigger: "manual", error: "summary unavailable" },
    { ...base("turn_result", 6, "turn-failure"), result: turnResult("turn-failure", "error") },
  ];
}

function message(role, text, compactReplacement = false) {
  return {
    role,
    ...(compactReplacement ? { metadata: { compactReplacement: true } } : {}),
    content: [{ type: "text", text }],
  };
}

function turnResult(turnId, type = "success") {
  return {
    type,
    sessionId: "session-compaction-restart",
    turnId,
    stopReason: type === "success" ? "completed" : "model_error",
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt: "2026-09-19T00:00:00.000Z",
    completedAt: "2026-09-19T00:00:00.000Z",
  };
}

function messageText(value) {
  return value.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
