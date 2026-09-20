#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Registry = await import(pathToFileURL(join(b0Root, "dist/src/tool/registry/ToolRegistry.js")).href);
const candidateRegistry = await import(pathToFileURL(join(candidateRoot, "dist/src/tool/registry/ToolRegistry.js")).href);

const cases = [
  { name: "register-alias-list", invoke: runRegisterAliasList },
  { name: "conflicts-and-unavailable", invoke: runConflictsAndUnavailable },
  { name: "clone-replace-unregister", invoke: runCloneReplaceUnregister },
];

const normalized = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0Registry.ToolRegistry);
  const actual = await runCase(testCase, candidateRegistry.ToolRegistry);
  assert.deepEqual(actual, expected, `Tool differential mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const altered = structuredClone(normalized[0].result);
altered.beforeHide.names.reverse();
assert.notDeepEqual(altered, normalized[0].result, "comparator sensitivity fixture did not detect changed tool order");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  compared: normalized.length,
}, null, 2) + "\n");

async function runCase(testCase, ToolRegistry) {
  const registry = new ToolRegistry();
  try {
    return await testCase.invoke({ registry, ToolRegistry });
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function runRegisterAliasList({ registry }) {
  const alpha = tool("alpha", ["a"]);
  const beta = tool("beta");
  registry.register(alpha);
  registry.register(beta);
  const beforeHide = {
    names: registry.list().map((item) => item.name),
    alias: registry.get("a")?.name,
    hasAlias: registry.has("a"),
    schemas: registry.toCanonicalSchemas(),
  };
  return { ok: true, beforeHide };
}

function runConflictsAndUnavailable({ registry }) {
  registry.register(tool("alpha", ["a"]));
  const errors = [];
  for (const candidate of [tool("alpha"), tool("beta", ["a"])]) {
    try {
      registry.register(candidate);
      errors.push({ ok: false });
    } catch (error) {
      errors.push({ ok: true, error: serializeError(error) });
    }
  }
  const diagnostic = { toolName: "missing", code: "setup_required", reason: "not configured" };
  registry.markUnavailable(diagnostic, ["missing_alias"]);
  return {
    ok: true,
    errors,
    unavailable: registry.listUnavailableEntries(),
    byAlias: registry.getUnavailable("missing_alias"),
    names: registry.list().map((item) => item.name),
  };
}

function runCloneReplaceUnregister({ ToolRegistry }) {
  const registry = new ToolRegistry();
  const originalRegistration = registry.register(tool("alpha"));
  const clone = registry.clone();
  clone.replace(tool("alpha", ["new_alpha"]));
  const before = {
    original: registry.get("alpha")?.description,
    clone: clone.get("alpha")?.description,
    newAlias: clone.get("new_alpha")?.name,
    originalAlias: registry.get("alpha")?.aliases,
  };
  const unregistered = clone.unregister("alpha");
  return { ok: true, before, unregistered, cloneList: clone.list().map((item) => item.name) };
}

function tool(name, aliases = [], requiredRuntimeCapabilities = []) {
  return {
    name,
    aliases,
    description: `${name} description`,
    kind: "custom",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    requiredRuntimeCapabilities,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: `${name} result` }] }),
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}
