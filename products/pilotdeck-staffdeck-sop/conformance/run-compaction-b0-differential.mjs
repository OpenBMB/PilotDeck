#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Module = await import(pathToFileURL(join(b0Root, "dist/src/context/compaction/CompactionEngine.js")).href);
const candidateModule = await import(pathToFileURL(join(candidateRoot, "dist/src/context/compaction/CompactionEngine.js")).href);

const cases = [
  { name: "manual-success-and-post-order", invoke: runManualSuccessAndPostOrder },
  { name: "protected-tool-turns", invoke: runProtectedToolTurns },
  { name: "summary-failure-cooldown", invoke: runSummaryFailureCooldown },
];

const normalized = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0Module);
  const actual = await runCase(testCase, candidateModule);
  assert.deepEqual(actual, expected, `Compaction differential mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const altered = structuredClone(normalized[1].result);
altered.result.messagesToKeep.reverse();
assert.notDeepEqual(
  altered,
  normalized[1].result,
  "comparator sensitivity fixture did not detect a changed compaction boundary order",
);

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  compared: normalized.length,
}, null, 2) + "\n");

async function runCase(testCase, module) {
  try {
    return await testCase.invoke(module);
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function runManualSuccessAndPostOrder({ CompactionEngine, buildPostCompactMessages }) {
  const requests = [];
  const lifecycle = [];
  const engine = new CompactionEngine({
    model: summaryModel(requests),
    provider: "test-provider",
    model_: "test-model",
    uuid: () => "compact-success",
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    lifecycle: { dispatch: (entry) => lifecycle.push(entry) },
  });
  const attachments = [{ role: "user", content: [{ type: "text", text: "attachment" }] }];
  const hookResults = [{ role: "user", content: [{ type: "text", text: "hook" }] }];
  const result = await engine.run({
    trigger: "manual",
    messages: basicMessages(),
    keepTailRatio: 0.2,
    attachments,
    hookResults,
    sessionId: "session-1",
    turnId: "turn-1",
  });
  return { ok: true, requests, lifecycle, result, post: buildPostCompactMessages(result) };
}

async function runProtectedToolTurns({ CompactionEngine, buildPostCompactMessages }) {
  const requests = [];
  const engine = new CompactionEngine({
    model: summaryModel(requests),
    provider: "test-provider",
    model_: "test-model",
    uuid: () => "compact-protected",
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    protectedToolNames: ["Task"],
  });
  const result = await engine.run({
    trigger: "auto",
    messages: protectedMessages(),
    keepTailRatio: 0.05,
  });
  return { ok: true, requests, result, post: buildPostCompactMessages(result) };
}

async function runSummaryFailureCooldown({ CompactionEngine }) {
  const requests = [];
  const lifecycle = [];
  const engine = new CompactionEngine({
    model: {
      async *stream(request) {
        requests.push(request);
        throw new Error("summary service unavailable");
      },
    },
    provider: "test-provider",
    model_: "test-model",
    uuid: (() => {
      let index = 0;
      return () => `compact-failure-${++index}`;
    })(),
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    lifecycle: { dispatch: (entry) => lifecycle.push(entry) },
  });
  const first = await engine.run({ trigger: "manual", messages: basicMessages(), keepTailRatio: 0.2 });
  const second = await engine.run({ trigger: "manual", messages: basicMessages(), keepTailRatio: 0.2 });
  return { ok: true, requests, lifecycle, first, second };
}

function summaryModel(requests) {
  return {
    async *stream(request) {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      yield {
        type: "text_delta",
        text: "## Objective\nContinue the task.\n\n## Current State\nA compact summary exists.\n\n## Remaining\nFinish verification.\n\n## Files And Artifacts\nNone.",
      };
      yield { type: "message_end", finishReason: "stop" };
    },
  };
}

function basicMessages() {
  return [
    { role: "user", content: [{ type: "text", text: "Original task and constraints." }] },
    { role: "assistant", content: [{ type: "text", text: "Initial analysis and progress." }] },
    { role: "user", content: [{ type: "text", text: "Continue with the implementation." }] },
    { role: "assistant", content: [{ type: "text", text: "Implementation is underway." }] },
    { role: "user", content: [{ type: "text", text: "Latest request remains verbatim." }] },
  ];
}

function protectedMessages() {
  return [
    { role: "user", content: [{ type: "text", text: "Begin task." }] },
    { role: "assistant", content: [{ type: "text", text: "Early analysis." }] },
    { role: "user", content: [{ type: "text", text: "Run protected work." }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "task-1", name: "Task", input: { prompt: "inspect" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "task-1", content: [{ type: "text", text: "protected output" }] }],
    },
    { role: "user", content: [{ type: "text", text: "Latest tail." }] },
  ];
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}
