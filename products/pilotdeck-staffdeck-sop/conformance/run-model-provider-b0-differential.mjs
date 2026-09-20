#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Module = await import(pathToFileURL(join(b0Root, "dist/src/model/providers/registry.js")).href);
const candidateModule = await import(pathToFileURL(join(candidateRoot, "dist/src/model/providers/registry.js")).href);

const cases = [
  { name: "list-protocols", invoke: runListProtocols },
  { name: "get-known-protocols", invoke: runGetKnownProtocols },
  { name: "unsupported-protocol-error", invoke: runUnsupportedProtocol },
  { name: "descriptor-isolation", invoke: runDescriptorIsolation },
];

const normalized = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0Module.ModelProviderRegistry);
  const actual = await runCase(testCase, candidateModule.ModelProviderRegistry);
  assert.deepEqual(actual, expected, `Model provider differential mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const altered = structuredClone(normalized[0].result);
altered.value.adapters.reverse();
assert.notDeepEqual(altered, normalized[0].result, "comparator sensitivity fixture did not detect a changed provider order");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  compared: normalized.length,
}, null, 2) + "\n");

async function runCase(testCase, registry) {
  try {
    return { ok: true, value: await testCase.invoke(registry) };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function runListProtocols(registry) {
  return { adapters: registry.list() };
}

function runGetKnownProtocols(registry) {
  const protocols = ["anthropic", "google", "openai", "openai-responses"];
  return { adapters: protocols.map((protocol) => registry.get(protocol)) };
}

function runUnsupportedProtocol(registry) {
  try {
    registry.get("unsupported");
    return { ok: false };
  } catch (error) {
    return { ok: true, error: serializeError(error) };
  }
}

function runDescriptorIsolation(registry) {
  const first = registry.get("openai");
  first.name = "mutated";
  return {
    mutatedRead: first,
    freshRead: registry.get("openai"),
    list: registry.list(),
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}
