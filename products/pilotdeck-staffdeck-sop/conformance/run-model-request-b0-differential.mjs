#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Module = await import(pathToFileURL(join(b0Root, "dist/src/model/request/buildModelRequest.js")).href);
const candidateModule = await import(pathToFileURL(join(candidateRoot, "dist/src/model/request/buildModelRequest.js")).href);

const protocols = ["openai", "openai-responses", "anthropic", "google"];
const normalized = [];
for (const protocol of protocols) {
  const expected = runCase(b0Module.buildModelRequest, protocol);
  const actual = runCase(candidateModule.buildModelRequest, protocol);
  assert.deepEqual(actual, expected, `Model request differential mismatch in ${protocol}`);
  normalized.push({ protocol, result: actual });
}

const altered = structuredClone(normalized[0].result);
altered.body.tools.reverse();
assert.notDeepEqual(altered, normalized[0].result, "comparator sensitivity fixture did not detect changed provider tool order");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: protocols,
  compared: protocols.length,
}, null, 2) + "\n");

function runCase(buildModelRequest, protocol) {
  try {
    return {
      ok: true,
      body: buildModelRequest(request(protocol), config(protocol)),
    };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function request(protocol) {
  return {
    provider: protocol,
    model: "test-model",
    systemPrompt: "You are a deterministic test agent.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Look up the record." }] },
      { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "lookup", input: { key: "record" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "record found" }] }] },
    ],
    tools: [
      { name: "lookup", description: "Look up a record.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      { name: "write", description: "Write a record.", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
    ],
    toolChoice: { type: "auto" },
    maxOutputTokens: 256,
    stream: true,
    speed: protocol === "google" ? undefined : 0.65,
    outputSchema: {
      name: "lookup_result",
      schema: { type: "object", properties: { status: { enum: ["ok", "missing"] } }, required: ["status"] },
    },
  };
}

function config(protocol) {
  return {
    providers: {
      [protocol]: {
        id: protocol,
        protocol,
        url: "https://example.invalid/v1",
        apiKey: "test-key",
        headers: {},
        speedMapping: protocol === "anthropic" ? "anthropic_speed" : protocol === "google" ? undefined : "openai_service_tier",
        models: {
          "test-model": {
            id: "test-model",
            capabilities: {
              supportsToolUse: true,
              supportsStreaming: true,
              supportsParallelToolCalls: true,
              supportsThinking: true,
              supportsSpeed: protocol !== "google",
              supportsJsonSchema: true,
              supportsSystemPrompt: true,
              supportsPromptCache: true,
              maxContextTokens: 128000,
              maxOutputTokens: 4096,
            },
            multimodal: { input: ["text"] },
          },
        },
      },
    },
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}
