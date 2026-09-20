#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const candidateRoot = dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";
const b0 = await import(pathToFileURL(join(b0Root, "dist/src/tool/scheduler/ConcurrentToolScheduler.js")).href);
const candidate = await import(pathToFileURL(join(candidateRoot, "dist/src/composition/runtimePorts.js")).href);

const cases = [
  { name: "all-safe", calls: [call("external_a"), call("native_b"), call("external_c")], safe: new Set(["external_a", "native_b", "external_c"]) },
  { name: "all-unsafe", calls: [call("external_a"), call("native_b"), call("external_c")], safe: new Set() },
  { name: "mixed", calls: [call("external_safe"), call("native_unsafe"), call("external_unsafe"), call("native_safe")], safe: new Set(["external_safe", "native_safe"]) },
];

try {
  const results = [];
  for (const scenario of cases) {
    const baseline = await runB0(scenario);
    const actual = await runCandidate(scenario);
    assert.deepEqual(actual, baseline, `${scenario.name} composeToolPorts scheduling differs from B0`);
    results.push({ name: scenario.name, projection: baseline });
  }
  if (process.env.PILOTDECK_COMPOSE_PORTS_INJECT_MISMATCH === "1") {
    const baseline = await runB0(cases[1]);
    const actual = await runCandidate(cases[1]);
    actual.unsafeStarts.reverse();
    assert.deepEqual(actual, baseline, "injected composed ToolPort order mismatch was not rejected");
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", baseline: b0Root, compared: results }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "FAIL", baseline: b0Root, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}

function call(name) {
  return { id: `call-${name}`, name, input: {} };
}

async function runB0(scenario) {
  const trace = traceFor(scenario.safe);
  const registry = { get: (name) => ({ isConcurrencySafe: () => scenario.safe.has(name) }) };
  const runtime = { execute: (call) => trace.execute(call) };
  const scheduler = new b0.ConcurrentToolScheduler(runtime, registry);
  const results = await scheduler.executeAll(scenario.calls, {});
  return trace.projection(results);
}

async function runCandidate(scenario) {
  const trace = traceFor(scenario.safe);
  const primaryNames = scenario.calls.filter((_, index) => index % 2 === 0).map((entry) => entry.name);
  const primary = port(primaryNames, scenario.safe, trace);
  const fallback = port(scenario.calls.filter((entry) => !primaryNames.includes(entry.name)).map((entry) => entry.name), scenario.safe, trace);
  const results = await candidate.composeToolPorts(primary, fallback).executeAll(scenario.calls, {}, {});
  return trace.projection(results);
}

function port(names, safe, trace) {
  const tools = names.map((name) => ({
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => safe.has(name),
    execute: async () => ({ content: [] }),
  }));
  return {
    list: () => tools,
    executeAll: async (calls) => Promise.all(calls.map((entry) => trace.execute(entry))),
  };
}

function traceFor(safe) {
  const starts = [];
  const unsafeStarts = [];
  let activeSafe = 0;
  let maxActiveSafe = 0;
  let safeCompleted = 0;
  let unsafeBeforeSafeFinished = false;
  const safeTotal = safe.size;
  return {
    async execute(entry) {
      const isSafe = safe.has(entry.name);
      starts.push(entry.name);
      if (isSafe) {
        activeSafe += 1;
        maxActiveSafe = Math.max(maxActiveSafe, activeSafe);
      } else {
        unsafeStarts.push(entry.name);
        unsafeBeforeSafeFinished ||= safeCompleted !== safeTotal;
      }
      await Promise.resolve();
      if (isSafe) {
        activeSafe -= 1;
        safeCompleted += 1;
      }
      return { type: "success", toolCallId: entry.id, toolName: entry.name, content: [], startedAt: "t0", completedAt: "t1" };
    },
    projection(results) {
      return {
        safeStarts: starts.filter((name) => safe.has(name)).sort(),
        unsafeStarts,
        unsafeBeforeSafeFinished,
        maxActiveSafe,
        resultSlots: results.map((result) => result.toolCallId),
      };
    },
  };
}
