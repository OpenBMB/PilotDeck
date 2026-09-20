#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";
const injection = process.env.PILOTDECK_MODEL_B0_INJECT_MISMATCH;

const baseline = await loadRuntime(b0Root);
const candidate = await loadRuntime(candidateRoot);
const cases = [
  { name: "configured-provider-selection-and-token-cap", invoke: runConfiguredSelection },
  { name: "stream-content-tool-usage", invoke: runContentToolUsageStream },
  { name: "stream-retry-rate-limit", invoke: runRateLimitRetryStream },
  { name: "stream-terminal-auth-error", invoke: runTerminalAuthErrorStream },
  { name: "stream-cancellation", invoke: runCancellationStream },
  { name: "complete-tool-usage", invoke: runCompleteToolUsage },
];

const compared = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, baseline);
  const actual = await runCase(testCase, candidate);
  assert.equal(expected.ok, true, `B0 Model runtime case failed: ${testCase.name}: ${expected.error?.message ?? "unknown error"}`);
  assert.equal(actual.ok, true, `candidate Model runtime case failed: ${testCase.name}: ${actual.error?.message ?? "unknown error"}`);
  maybeInjectMismatch(testCase.name, actual);
  assert.deepEqual(actual, expected, `Model runtime differential mismatch in ${testCase.name}`);
  compared.push({ name: testCase.name, result: actual });
}

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: compared.map(({ name }) => name),
  compared: compared.length,
  sensitivity: "PILOTDECK_MODEL_B0_INJECT_MISMATCH=usage|error|event_order exits nonzero",
}, null, 2) + "\n");

async function loadRuntime(root) {
  const load = (path) => import(pathToFileURL(join(root, "dist", path)).href);
  const [config, request, validation, streaming] = await Promise.all([
    load("src/model/config/parseModelConfig.js"),
    load("src/model/request/buildModelRequest.js"),
    load("src/model/request/validateModelRequest.js"),
    load("src/model/streaming/streamModel.js"),
  ]);
  return {
    parseModelConfig: config.parseModelConfig,
    buildModelRequest: request.buildModelRequest,
    validateModelRequest: validation.validateModelRequest,
    complete: streaming.complete,
    streamModel: streaming.streamModel,
  };
}

async function runCase(testCase, runtime) {
  try {
    return { ok: true, value: await testCase.invoke(runtime) };
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

function makeConfig(runtime) {
  return runtime.parseModelConfig({
    providers: {
      primary: {
        protocol: "openai",
        url: "https://model-diff.invalid/v1",
        apiKey: "model-diff-test-key",
        retry: {
          requestMaxRetries: 1,
          streamMaxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: 0,
        },
        models: {
          "approval-model": {
            capabilities: {
              supportsToolUse: true,
              supportsStreaming: true,
              supportsSystemPrompt: true,
              supportsPromptCache: true,
              supportsParallelToolCalls: true,
              maxContextTokens: 4096,
              maxOutputTokens: 77,
            },
            multimodal: { input: ["text"] },
          },
        },
      },
    },
  });
}

function request(overrides = {}) {
  return {
    provider: "primary",
    model: "approval-model",
    systemPrompt: "You are an approval assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Check approval A-1." }] }],
    tools: [{
      name: "lookup_approval",
      description: "Read an approval record.",
      inputSchema: {
        type: "object",
        properties: { record: { type: "string" } },
        required: ["record"],
      },
    }],
    ...overrides,
  };
}

function runConfiguredSelection(runtime) {
  const config = makeConfig(runtime);
  const resolved = runtime.validateModelRequest(request({ stream: true }), config);
  const body = runtime.buildModelRequest(request({ stream: true }), config);
  let invalidSelection;
  try {
    runtime.validateModelRequest(request({ model: "not-configured", stream: true }), config);
    invalidSelection = { accepted: true };
  } catch (error) {
    invalidSelection = { accepted: false, error: serializeError(error) };
  }
  return {
    selection: {
      provider: resolved.provider.id,
      protocol: resolved.provider.protocol,
      model: resolved.model.id,
      maxContextTokens: resolved.model.capabilities.maxContextTokens,
      maxOutputTokens: resolved.model.capabilities.maxOutputTokens,
    },
    providerBody: body,
    invalidSelection,
  };
}

async function runContentToolUsageStream(runtime) {
  return collectStream(runtime, [sse([
    { id: "stream-content-tool-usage", choices: [{ delta: { content: "approval found " } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-approval", type: "function", function: { name: "lookup_approval", arguments: "{\"record\":\"A-1\"}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 17, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens: 3, total_tokens: 20 } },
  ])]);
}

async function runRateLimitRetryStream(runtime) {
  return collectStream(runtime, [
    jsonResponse({ error: { type: "rate_limit_error", message: "rate limit; retry in 1ms" } }, 429, { "retry-after": "0" }),
    sse([
      { id: "stream-retry-rate-limit", choices: [{ delta: { content: "retried" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
    ]),
  ]);
}

async function runTerminalAuthErrorStream(runtime) {
  return collectStream(runtime, [
    jsonResponse({ error: { type: "invalid_api_key", message: "invalid api key" } }, 401),
  ]);
}

async function runCancellationStream(runtime) {
  const config = makeConfig(runtime);
  const controller = new AbortController();
  const requests = [];
  try {
    for await (const event of runtime.streamModel(request({ stream: true }), config, {
      signal: controller.signal,
      fetch: async (url, init) => {
        requests.push(recordRequest(url, init));
        return await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort(new Error("model runtime differential cancellation"));
        });
      },
    })) {
      throw new Error(`unexpected event after cancellation: ${event.type}`);
    }
    return { requests, completed: true };
  } catch (error) {
    return { requests, completed: false, error: serializeError(error) };
  }
}

async function runCompleteToolUsage(runtime) {
  const config = makeConfig(runtime);
  const requests = [];
  const response = await runtime.complete(request(), config, {
    fetch: async (url, init) => {
      requests.push(recordRequest(url, init));
      return jsonResponse({
        id: "complete-tool-usage",
        choices: [{
          message: {
            role: "assistant",
            content: "approval record is ready",
            tool_calls: [{ id: "call-complete", type: "function", function: { name: "lookup_approval", arguments: "{\"record\":\"A-1\"}" } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 13, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 5, total_tokens: 18 },
      });
    },
  });
  return { requests, response: normalizeResponse(response) };
}

async function collectStream(runtime, responses) {
  const config = makeConfig(runtime);
  const requests = [];
  const retryProgress = [];
  const events = [];
  let responseIndex = 0;
  for await (const event of runtime.streamModel(request({ stream: true }), config, {
    fetch: async (url, init) => {
      requests.push(recordRequest(url, init));
      const response = responses[responseIndex++];
      if (!response) throw new Error("unexpected provider retry");
      return response;
    },
    onRetryProgress: (progress) => retryProgress.push(progress),
  })) {
    events.push(normalizeEvent(event));
  }
  return { requests, retryProgress, events };
}

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function recordRequest(url, init) {
  return {
    url: String(url),
    body: JSON.parse(String(init?.body ?? "{}")),
  };
}

function normalizeEvent(event) {
  return stripRaw(structuredClone(event));
}

function normalizeResponse(response) {
  return stripRaw(structuredClone(response));
}

function stripRaw(value) {
  if (Array.isArray(value)) return value.map(stripRaw);
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (key === "raw") delete value[key];
    else value[key] = stripRaw(child);
  }
  return value;
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

function maybeInjectMismatch(name, actual) {
  if (!injection) return;
  if (injection === "usage" && name === "stream-content-tool-usage") {
    const usage = actual.value?.events?.find((event) => event.type === "usage");
    if (usage) usage.usage.totalTokens += 1;
    return;
  }
  if (injection === "error" && name === "stream-terminal-auth-error") {
    const error = actual.value?.events?.find((event) => event.type === "error");
    if (error) error.error.code = "server_error";
    return;
  }
  if (injection === "event_order" && name === "stream-content-tool-usage") {
    actual.value?.events?.reverse();
    return;
  }
  if (!["usage", "error", "event_order"].includes(injection)) {
    throw new Error("PILOTDECK_MODEL_B0_INJECT_MISMATCH must be usage, error, or event_order.");
  }
}
