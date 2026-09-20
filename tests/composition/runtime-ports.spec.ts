import assert from "node:assert/strict";
import test from "node:test";

import { composeToolPorts } from "../../src/composition/runtimePorts.js";
import type { ToolPort } from "../../src/agent/modules/protocol.js";
import type { PilotDeckToolCall, PilotDeckToolDefinition, PilotDeckToolResult } from "../../src/tool/index.js";

test("composed ToolPorts preserve per-owner batches while dispatching owners in parallel", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let primaryStarted!: () => void;
  let fallbackStarted!: () => void;
  const bothStarted = Promise.all([
    new Promise<void>((resolve) => { primaryStarted = resolve; }),
    new Promise<void>((resolve) => { fallbackStarted = resolve; }),
  ]);
  const batches: string[][] = [];
  const primary = controlledPort("primary", [tool("external_one"), tool("external_two")], batches, primaryStarted, released);
  const fallback = controlledPort("fallback", [tool("native")], batches, fallbackStarted, released);

  const result = composeToolPorts(primary, fallback).executeAll([
    { id: "external-one", name: "external_one", input: {} },
    { id: "native", name: "native", input: {} },
    { id: "external-two", name: "external_two", input: {} },
  ], {} as never, {} as never);

  await bothStarted;
  assert.deepEqual(
    batches.map((batch) => batch.join(",")).sort(),
    ["external_one,external_two", "native"],
  );
  release();
  assert.deepEqual((await result).map((entry) => entry.toolCallId), ["external-one", "native", "external-two"]);
});

test("composed ToolPorts retain B0 global ordering for non-concurrency-safe calls across owners", async () => {
  const starts: string[] = [];
  const gates = gatesFor("external_a", "native_b", "external_c");
  const primary = gatedPort("primary", [tool("external_a", false), tool("external_c", false)], starts, gates);
  const fallback = gatedPort("fallback", [tool("native_b", false)], starts, gates);
  const result = composeToolPorts(primary, fallback).executeAll([
    { id: "external-a", name: "external_a", input: {} },
    { id: "native-b", name: "native_b", input: {} },
    { id: "external-c", name: "external_c", input: {} },
  ], {} as never, {} as never);

  await gates.external_a.started;
  assert.deepEqual(starts, ["external_a"]);
  gates.external_a.release();
  await gates.native_b.started;
  assert.deepEqual(starts, ["external_a", "native_b"]);
  gates.native_b.release();
  await gates.external_c.started;
  assert.deepEqual(starts, ["external_a", "native_b", "external_c"]);
  gates.external_c.release();
  assert.deepEqual((await result).map((entry) => entry.toolCallId), ["external-a", "native-b", "external-c"]);
});

test("composed ToolPorts complete safe calls before globally serializing mixed-owner unsafe calls", async () => {
  const starts: string[] = [];
  const gates = gatesFor("external_safe", "native_unsafe", "external_unsafe", "native_safe");
  const primary = gatedPort("primary", [tool("external_safe", true), tool("external_unsafe", false)], starts, gates);
  const fallback = gatedPort("fallback", [tool("native_unsafe", false), tool("native_safe", true)], starts, gates);
  const result = composeToolPorts(primary, fallback).executeAll([
    { id: "external-safe", name: "external_safe", input: {} },
    { id: "native-unsafe", name: "native_unsafe", input: {} },
    { id: "external-unsafe", name: "external_unsafe", input: {} },
    { id: "native-safe", name: "native_safe", input: {} },
  ], {} as never, {} as never);

  await Promise.all([gates.external_safe.started, gates.native_safe.started]);
  assert.deepEqual(starts.slice().sort(), ["external_safe", "native_safe"]);
  gates.external_safe.release();
  gates.native_safe.release();
  await gates.native_unsafe.started;
  assert.deepEqual(starts, ["external_safe", "native_safe", "native_unsafe"]);
  gates.native_unsafe.release();
  await gates.external_unsafe.started;
  gates.external_unsafe.release();
  assert.deepEqual((await result).map((entry) => entry.toolCallId), [
    "external-safe", "native-unsafe", "external-unsafe", "native-safe",
  ]);
});

function controlledPort(
  owner: string,
  tools: PilotDeckToolDefinition[],
  batches: string[][],
  started: () => void,
  released: Promise<void>,
): ToolPort {
  return {
    list: () => tools,
    async executeAll(calls: PilotDeckToolCall[]): Promise<PilotDeckToolResult[]> {
      batches.push(calls.map((call) => call.name));
      started();
      await released;
      const now = new Date().toISOString();
      return calls.map((call) => ({
        type: "success",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: owner }],
        startedAt: now,
        completedAt: now,
      }));
    },
  };
}

function tool(name: string, concurrencySafe: boolean = true): PilotDeckToolDefinition {
  return {
    name,
    description: name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => true,
    isConcurrencySafe: () => concurrencySafe,
    execute: async () => ({ content: [] }),
  };
}

function gatesFor(...names: string[]) {
  return Object.fromEntries(names.map((name) => {
    let release!: () => void;
    let markStarted!: () => void;
    return [name, {
      released: new Promise<void>((resolve) => { release = resolve; }),
      started: new Promise<void>((resolve) => { markStarted = resolve; }),
      release,
      markStarted,
    }];
  })) as Record<string, { released: Promise<void>; started: Promise<void>; release(): void; markStarted(): void }>;
}

function gatedPort(
  owner: string,
  tools: PilotDeckToolDefinition[],
  starts: string[],
  gates: Record<string, { released: Promise<void>; started: Promise<void>; release(): void; markStarted(): void }>,
): ToolPort {
  return {
    list: () => tools,
    async executeAll(calls: PilotDeckToolCall[]): Promise<PilotDeckToolResult[]> {
      for (const call of calls) {
        starts.push(call.name);
        gates[call.name]!.markStarted();
      }
      await Promise.all(calls.map((call) => gates[call.name]!.released));
      const now = new Date().toISOString();
      return calls.map((call) => ({
        type: "success",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: owner }],
        startedAt: now,
        completedAt: now,
      }));
    },
  };
}
