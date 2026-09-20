#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Module = await import(pathToFileURL(join(b0Root, "dist/src/agent/loop/AgentLoop.js")).href);
const candidateModule = await import(pathToFileURL(join(candidateRoot, "dist/src/agent/loop/AgentLoop.js")).href);

const cases = [
  { name: "single-turn-completion", invoke: runSingleTurnCompletion },
  { name: "tool-roundtrip", invoke: runToolRoundtrip },
  { name: "max-turns-after-tool", invoke: runMaxTurnsAfterTool },
  { name: "multi-turn-steer", invoke: runMultiTurnSteer },
  { name: "cancellation-during-work", invoke: runCancellationDuringWork },
  { name: "pre-aborted-turn", invoke: runPreAbortedTurn },
  { name: "model-error-projection", invoke: runModelErrorProjection },
];

const normalized = [];
const differences = [];
for (const testCase of cases) {
  const expected = normalize(await runCase(testCase, b0Module.AgentLoop));
  const actual = normalize(await runCase(testCase, candidateModule.AgentLoop));
  try {
    assert.deepEqual(actual, expected, `AgentLoop differential mismatch in ${testCase.name}`);
    normalized.push({ name: testCase.name, result: actual });
  } catch (error) {
    differences.push({ name: testCase.name, message: error.message });
  }
}

if (process.env.PILOTDECK_DIFFERENTIAL_TEST_INJECT_MISMATCH === "1") {
  differences.push({ name: "injected-mismatch", message: "Intentional runner verification mismatch." });
}

if (normalized.length > 0) {
  const altered = structuredClone(normalized[0].result);
  altered.events.reverse();
  assert.notDeepEqual(altered, normalized[0].result, "comparator sensitivity fixture did not detect changed AgentLoop event order");
}

const report = {
  status: differences.length === 0 ? "PASS" : "FAIL",
  baseline: b0Root,
  candidate: candidateRoot,
  passedCases: normalized.map(({ name }) => name),
  differences,
  compared: cases.length,
};
if (differences.length > 0) {
  process.stderr.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

async function runCase(testCase, AgentLoop) {
  try {
    return await testCase.invoke(AgentLoop);
  } catch (error) {
    return { ok: false, error: serializeError(error) };
  }
}

async function runSingleTurnCompletion(AgentLoop) {
  const trace = [];
  const loop = createLoop(AgentLoop, trace);
  const events = [];
  let completed;
  for await (const event of loop.run(input())) {
    events.push(event);
  }
  completed = events.at(-1)?.result;
  return { ok: true, events, result: completed, trace };
}

async function runPreAbortedTurn(AgentLoop) {
  const trace = [];
  const loop = createLoop(AgentLoop, trace);
  const abort = new AbortController();
  abort.abort();
  const events = [];
  for await (const event of loop.run({ ...input(), turnId: "turn-aborted", abortSignal: abort.signal })) {
    events.push(event);
  }
  return { ok: true, events, trace };
}

async function runToolRoundtrip(AgentLoop) {
  const trace = [];
  const toolExecutions = [];
  const loop = createLoop(AgentLoop, trace, {
    toolRoundtrip: true,
    onToolExecutions: (calls) => toolExecutions.push(calls),
  });
  const events = [];
  for await (const event of loop.run(input())) events.push(event);
  return { ok: true, events, trace, toolExecutions };
}

async function runMaxTurnsAfterTool(AgentLoop) {
  const trace = [];
  const loop = createLoop(AgentLoop, trace, { toolRoundtrip: true });
  const events = [];
  for await (const event of loop.run({ ...input(), turnId: "turn-max", maxTurns: 1 })) events.push(event);
  return { ok: true, events, trace };
}

async function runMultiTurnSteer(AgentLoop) {
  const trace = [];
  let modelRequests = 0;
  const steer = {
    itemId: "steer-1",
    message: { role: "user", content: [{ type: "text", text: "Use the updated approval record." }] },
  };
  const loop = createLoop(AgentLoop, trace, {
    toolRoundtrip: true,
    onModelRequest: () => { modelRequests += 1; },
    drainSteerMessages: () => modelRequests >= 1 && modelRequests < 2 ? [steer] : [],
  });
  const events = [];
  for await (const event of loop.run({ ...input(), turnId: "turn-steer" })) events.push(event);
  return { ok: true, events, trace, modelRequests };
}

async function runCancellationDuringWork(AgentLoop) {
  const trace = [];
  const loop = createLoop(AgentLoop, trace, { cancelDuringWork: true });
  const abort = new AbortController();
  setTimeout(() => abort.abort("test_cancel"), 5);
  const events = [];
  for await (const event of loop.run({ ...input(), turnId: "turn-cancel", abortSignal: abort.signal })) events.push(event);
  return { ok: true, events, trace };
}

async function runModelErrorProjection(AgentLoop) {
  const trace = [];
  const loop = createLoop(AgentLoop, trace, { error: true });
  const events = [];
  for await (const event of loop.run({ ...input(), turnId: "turn-error" })) {
    events.push(event);
  }
  return { ok: true, events, trace };
}

function createLoop(AgentLoop, trace, options = {}) {
  const config = {
    provider: "test-provider",
    model: "test-model",
    cwd: "/workspace",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/workspace",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
  const dependencies = {
    router: {
      invalidateSticky: () => ({ orchestrating: false }),
      async decide({ request }) {
        trace.push({ type: "decide", request });
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "explicit",
          mutations: {},
        };
      },
      materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
      async *execute(_decision, request, context) {
        trace.push({ type: "execute", request });
        yield { type: "message_start", role: "assistant" };
        if (options.cancelDuringWork) {
          await waitForAbort(context?.abortSignal);
          return;
        }
        if (options.error) {
          yield {
            type: "error",
            error: {
              provider: "test-provider",
              protocol: "openai",
              code: "server_error",
              message: "model unavailable",
              retryable: false,
            },
          };
          return;
        }
        if (options.toolRoundtrip) {
          const hasToolResult = request.messages.some((message) =>
            message.content.some((block) => block.type === "tool_result"));
          if (!hasToolResult) {
            yield { type: "tool_call_start", id: "lookup-1", name: "lookup" };
            yield {
              type: "tool_call_end",
              toolCall: { id: "lookup-1", name: "lookup", input: { key: "approval" } },
            };
            yield { type: "message_end", finishReason: "tool_call" };
            return;
          }
          yield { type: "text_delta", text: request.messages.some((message) =>
            message.content.some((block) => block.type === "text" && block.text.includes("updated approval")))
            ? "updated lookup complete"
            : "lookup complete" };
          yield { type: "message_end", finishReason: "stop" };
          return;
        }
        yield { type: "text_delta", text: "deterministic completion" };
        yield { type: "message_end", finishReason: "stop" };
      },
      async *stream(_request) {
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    tools: {
      registry: {
        list: () => options.toolRoundtrip ? [
          {
            name: "lookup",
            description: "Look up a deterministic approval record.",
            kind: "custom",
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            execute: async () => ({ content: [{ type: "text", text: "approval record" }] }),
          },
        ] : [],
      },
      scheduler: {
        executeAll: async (calls) => {
          options.onToolExecutions?.(calls);
          return calls.map((call) => ({
            type: "success",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "approval record" }],
            startedAt: "2026-09-19T00:00:00.000Z",
            completedAt: "2026-09-19T00:00:00.001Z",
          }));
        },
      },
    },
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    uuid: () => "agent-loop-fixed-id",
  };
  if (options.onModelRequest) {
    const originalExecute = dependencies.router.execute;
    dependencies.router.execute = async function* executeWithObserver(decision, request, context) {
      options.onModelRequest(request);
      yield* originalExecute.call(this, decision, request, context);
    };
  }
  const loop = typeof AgentLoop.fromDependencies === "function"
    ? AgentLoop.fromDependencies(config, dependencies)
    : new AgentLoop(config, dependencies);
  return loop;
}

function waitForAbort(signal) {
  if (!signal) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

function input() {
  return {
    sessionId: "agent-session",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

function normalize(value) {
  if (typeof value === "string") {
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
