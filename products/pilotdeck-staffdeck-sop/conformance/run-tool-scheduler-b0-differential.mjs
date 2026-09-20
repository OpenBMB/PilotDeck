#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0 = await import(pathToFileURL(join(b0Root, "dist/src/tool/scheduler/ConcurrentToolScheduler.js")).href);
const candidate = await import(pathToFileURL(join(candidateRoot, "dist/src/tool/scheduler/ConcurrentToolScheduler.js")).href);

const cases = [
  { name: "mixed-concurrency-preserves-call-order", invoke: runMixedConcurrency },
  { name: "abort-signal-reaches-each-execution", invoke: runAbortSignal },
];

const passed = [];
const differences = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0.ConcurrentToolScheduler);
  const actual = await runCase(testCase, candidate.ConcurrentToolScheduler);
  try {
    assert.deepEqual(actual, expected, `Tool scheduler differential mismatch in ${testCase.name}`);
    passed.push(testCase.name);
  } catch (error) {
    differences.push({ name: testCase.name, message: error.message, expected, actual });
  }
}

assert.equal(differences.length, 0, JSON.stringify(differences, null, 2));
const sensitivity = await runMixedConcurrency(candidate.ConcurrentToolScheduler, { reverseResults: true });
assert.notDeepEqual(sensitivity, await runMixedConcurrency(candidate.ConcurrentToolScheduler), "scheduler comparator sensitivity fixture did not detect changed result order");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  passedCases: passed,
  compared: cases.length,
}, null, 2) + "\n");

async function runCase(testCase, Scheduler) {
  try {
    return await testCase.invoke(Scheduler);
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function runMixedConcurrency(Scheduler, options = {}) {
  const execution = [];
  const tools = new Map([
    ["safe-a", definition(true)],
    ["serial", definition(false)],
    ["safe-b", definition(true)],
  ]);
  const registry = { get: (name) => tools.get(name) };
  const runtime = {
    async execute(call) {
      execution.push(`start:${call.name}`);
      if (call.name === "safe-a") await delay(4);
      if (call.name === "safe-b") await delay(1);
      execution.push(`end:${call.name}`);
      return result(call, options.reverseResults ? `changed-${call.id}` : call.id);
    },
  };
  const scheduler = new Scheduler(runtime, registry);
  const calls = [
    { id: "call-a", name: "safe-a", input: {} },
    { id: "call-s", name: "serial", input: {} },
    { id: "call-b", name: "safe-b", input: {} },
  ];
  const results = await scheduler.executeAll(calls, {});
  return { ok: true, execution, resultIds: results.map((item) => item.data.id) };
}

async function runAbortSignal(Scheduler) {
  const abort = new AbortController();
  abort.abort("fixture_cancel");
  const execution = [];
  const tools = new Map([["safe", definition(true)], ["serial", definition(false)]]);
  const registry = { get: (name) => tools.get(name) };
  const runtime = {
    async execute(call, context) {
      execution.push({ name: call.name, aborted: context.abortSignal.aborted, reason: String(context.abortSignal.reason) });
      return result(call, context.abortSignal.aborted ? "cancelled" : "completed");
    },
  };
  const scheduler = new Scheduler(runtime, registry);
  const calls = [{ id: "call-1", name: "safe", input: {} }, { id: "call-2", name: "serial", input: {} }];
  const results = await scheduler.executeAll(calls, { abortSignal: abort.signal });
  return { ok: true, execution, resultIds: results.map((item) => item.data.id) };
}

function definition(concurrencySafe) {
  return { name: concurrencySafe ? "safe" : "serial", isConcurrencySafe: () => concurrencySafe };
}

function result(call, id) {
  return {
    type: "success",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: id }],
    data: { id },
    startedAt: "2026-09-19T00:00:00.000Z",
    completedAt: "2026-09-19T00:00:00.001Z",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(error) {
  return { name: error?.name, code: error?.code, message: typeof error?.message === "string" ? error.message : String(error) };
}
