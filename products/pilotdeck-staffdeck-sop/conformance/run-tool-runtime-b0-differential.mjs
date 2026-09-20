#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Runtime = await import(pathToFileURL(join(b0Root, "dist/src/tool/execution/ToolRuntime.js")).href);
const candidateRuntime = await import(pathToFileURL(join(candidateRoot, "dist/src/tool/execution/ToolRuntime.js")).href);
const b0Registry = await import(pathToFileURL(join(b0Root, "dist/src/tool/registry/ToolRegistry.js")).href);
const candidateRegistry = await import(pathToFileURL(join(candidateRoot, "dist/src/tool/registry/ToolRegistry.js")).href);

const cases = [
  { name: "permission-allow-and-success", invoke: runAllowSuccess },
  { name: "permission-denied", invoke: runPermissionDenied },
  { name: "missing-and-unavailable-tools", invoke: runMissingAndUnavailable },
  { name: "invalid-input", invoke: runInvalidInput },
  { name: "execution-failure", invoke: runExecutionFailure },
];

const normalized = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0Runtime.ToolRuntime, b0Registry.ToolRegistry);
  const actual = await runCase(testCase, candidateRuntime.ToolRuntime, candidateRegistry.ToolRegistry);
  assert.deepEqual(actual, expected, `ToolRuntime differential mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const altered = structuredClone(normalized[1].result);
altered.result.error.code = "permission_required";
assert.notDeepEqual(
  altered,
  normalized[1].result,
  "comparator sensitivity fixture did not detect a changed tool error code",
);

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  compared: normalized.length,
}, null, 2) + "\n");

async function runCase(testCase, ToolRuntime, ToolRegistry) {
  try {
    return await testCase.invoke(ToolRuntime, ToolRegistry);
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function runAllowSuccess(ToolRuntime, ToolRegistry) {
  let executions = 0;
  let decisions = 0;
  const registry = new ToolRegistry();
  registry.register(tool("write_note", async (input) => {
    executions += 1;
    return { content: [{ type: "text", text: `wrote ${input.value}` }], data: { saved: input.value } };
  }));
  const runtime = new ToolRuntime(registry, permission("allow", () => { decisions += 1; }));
  const result = await runtime.execute({ id: "call-1", name: "write_note", input: { value: "note" } }, context());
  return { ok: true, result, executions, decisions };
}

async function runPermissionDenied(ToolRuntime, ToolRegistry) {
  let executions = 0;
  let decisions = 0;
  const registry = new ToolRegistry();
  registry.register(tool("write_note", async () => {
    executions += 1;
    return { content: [{ type: "text", text: "unexpected" }] };
  }));
  const runtime = new ToolRuntime(registry, permission("deny", () => { decisions += 1; }));
  const result = await runtime.execute({ id: "call-2", name: "write_note", input: { value: "note" } }, context());
  return { ok: true, result, executions, decisions };
}

async function runMissingAndUnavailable(ToolRuntime, ToolRegistry) {
  const registry = new ToolRegistry();
  registry.markUnavailable({ toolName: "setup_tool", code: "setup_required", reason: "configure it" }, ["setup"]);
  const runtime = new ToolRuntime(registry, permission("allow"));
  const missing = await runtime.execute({ id: "call-3", name: "missing", input: {} }, context());
  const unavailable = await runtime.execute({ id: "call-4", name: "setup", input: {} }, context());
  return { ok: true, missing, unavailable };
}

async function runInvalidInput(ToolRuntime, ToolRegistry) {
  let executions = 0;
  let decisions = 0;
  const registry = new ToolRegistry();
  registry.register(tool("write_note", async () => {
    executions += 1;
    return { content: [{ type: "text", text: "unexpected" }] };
  }));
  const runtime = new ToolRuntime(registry, permission("allow", () => { decisions += 1; }));
  const result = await runtime.execute({ id: "call-5", name: "write_note", input: {} }, context());
  return { ok: true, result, executions, decisions };
}

async function runExecutionFailure(ToolRuntime, ToolRegistry) {
  let decisions = 0;
  const registry = new ToolRegistry();
  registry.register(tool("write_note", async () => {
    throw new Error("write failed");
  }));
  const runtime = new ToolRuntime(registry, permission("allow", () => { decisions += 1; }));
  const result = await runtime.execute({ id: "call-6", name: "write_note", input: { value: "note" } }, context());
  return { ok: true, result, decisions };
}

function tool(name, execute) {
  return {
    name,
    description: `${name} description`,
    kind: "custom",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute,
  };
}

function permission(decision, onDecision = () => {}) {
  return {
    async decide() {
      onDecision();
      if (decision === "allow") {
        return { type: "allow", reason: { type: "runtime", message: "approved" } };
      }
      return {
        type: "deny",
        reason: { type: "runtime", message: "denied" },
        message: "permission denied by fixture",
      };
    },
  };
}

function context() {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/workspace",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: false,
    },
    now: () => new Date("2026-09-19T00:00:00.000Z"),
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}
