#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => undefined;
console.warn = () => undefined;
let expected;
let actual;
try {
  expected = await runCase(b0Root);
  actual = await runCase(candidateRoot);
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}
if (process.env.PILOTDECK_DIFFERENTIAL_TEST_INJECT_MISMATCH === "1") {
  actual.audit[0].toolName = "injected-tool-name";
}
assert.deepEqual(actual, expected, "Tool Gateway restart result/audit differential mismatch");

const alteredAudit = structuredClone(actual);
alteredAudit.audit.reverse();
assert.notDeepEqual(alteredAudit, actual, "comparator sensitivity fixture did not detect audit-order change");
const alteredResult = structuredClone(actual);
alteredResult.toolResults[0].result.toolName = "injected-tool-name";
assert.notDeepEqual(alteredResult, actual, "comparator sensitivity fixture did not detect tool-result change");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  compared: [
    "native-gateway-tool-results",
    "durable-tool-audit-projection",
    "workspace-read-write-side-effects",
    "process-side-effect",
    "post-restart-audit-order",
    "native-tool-timeout",
    "native-tool-abort-fail-closed",
  ],
  audit: actual.audit,
}, null, 2) + "\n");

async function runCase(root) {
  const [{ createLocalGateway }, { createAgentProjectSessionStorage }, { readTranscript }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/cli/createLocalGateway.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/storage/ProjectSessionStorage.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/transcript/TranscriptReader.js")).href),
  ]);
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-tool-gateway-restart-"));
  const sessionKey = "tool-gateway-restart";
  let gateway;
  try {
    await writeFile(join(projectRoot, "seed.txt"), "original tool input\n", "utf8");
    await writeFile(join(projectRoot, "pilotdeck.yaml"), config(), "utf8");

    const firstModel = createModel("initial");
    gateway = createGateway(createLocalGateway, projectRoot, firstModel);
    await submit(gateway.gateway, sessionKey, projectRoot, "Read, write, and record the workspace artifacts.");

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: sessionKey,
    });
    const beforeRestart = await readTranscript(storage.transcriptPath);
    const beforeAudit = auditProjection(beforeRestart.entries);
    const beforeResults = toolResults(beforeRestart.entries, projectRoot);
    assert.deepEqual(beforeAudit.map((record) => record.toolName), ["read_file", "write_file", "bash"]);
    assert.deepEqual(beforeAudit.map((record) => record.status), ["success", "success", "success"]);
    assert.equal(await readFile(join(projectRoot, "written.txt"), "utf8"), "written by gateway tool\n");
    assert.equal(await readFile(join(projectRoot, "process.txt"), "utf8"), "process side effect\n");

    await gateway.dispose();
    const restartedModel = createModel("restart");
    gateway = createGateway(createLocalGateway, projectRoot, restartedModel);
    await submit(gateway.gateway, sessionKey, projectRoot, "Confirm the prior tool work after restart.");
    const afterRestart = await readTranscript(storage.transcriptPath);
    const afterAudit = auditProjection(afterRestart.entries);
    assert.deepEqual(afterAudit.slice(0, beforeAudit.length), beforeAudit);
    assert.equal(restartedModel.toolCalls, 0, "restart should not replay settled Tool calls");

    await gateway.dispose();
    const timeoutSession = "tool-gateway-timeout";
    gateway = createGateway(createLocalGateway, projectRoot, createModel("timeout"));
    await submit(gateway.gateway, timeoutSession, projectRoot, "Exercise the native Tool timeout.");
    const timeoutStorage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: timeoutSession });
    const timeoutTranscript = await readTranscript(timeoutStorage.transcriptPath);
    const timeoutAudit = auditProjection(timeoutTranscript.entries);
    assert.deepEqual(timeoutAudit, [{
      step: 0,
      toolCallId: "restart-timeout",
      toolName: "bash",
      status: "error",
      errorCode: "tool_timeout",
    }]);
    assert.equal(await exists(join(projectRoot, "timeout-side-effect.txt")), false);

    await gateway.dispose();
    const abortSession = "tool-gateway-abort";
    let abortCompletion;
    const abortModel = createModel("abort", () => {
      abortCompletion = new Promise((resolve, reject) => {
        setTimeout(() => {
          void gateway.gateway.abortTurn({ sessionKey: abortSession, reason: "differential abort" })
            .then(resolve, reject);
        }, 25);
      });
    });
    gateway = createGateway(createLocalGateway, projectRoot, abortModel);
    await submit(gateway.gateway, abortSession, projectRoot, "Cancel the native Tool execution.");
    await abortCompletion;
    assert.equal(abortModel.toolCalls, 1, "abort case must reach native Tool dispatch");
    const abortStorage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: abortSession });
    const abortTranscript = await readTranscript(abortStorage.transcriptPath);
    const abortAudit = auditProjection(abortTranscript.entries);
    assert.deepEqual(abortAudit, [], JSON.stringify(abortTranscript.entries));
    assert.equal(await exists(join(projectRoot, "abort-side-effect.txt")), false);

    return normalize({
      toolResults: beforeResults,
      audit: beforeAudit,
      postRestartAudit: afterAudit,
      timeout: { audit: timeoutAudit, terminal: terminalProjection(timeoutTranscript.entries) },
      abort: { audit: abortAudit, terminal: terminalProjection(abortTranscript.entries) },
      files: {
        seed: await readFile(join(projectRoot, "seed.txt"), "utf8"),
        written: await readFile(join(projectRoot, "written.txt"), "utf8"),
        process: await readFile(join(projectRoot, "process.txt"), "utf8"),
      },
    }, projectRoot);
  } finally {
    await gateway?.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function createGateway(createLocalGateway, projectRoot, model) {
  return createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
}

async function submit(gateway, sessionKey, projectRoot, message) {
  for await (const _event of gateway.submitTurn({
    sessionKey,
    workspaceCwd: projectRoot,
    channelKey: "test",
    message,
    mode: "bypassPermissions",
  })) {
    // Draining the real Gateway turn persists its Tool results and terminal state.
  }
}

function createModel(phase, onToolCallsEmitted) {
  return {
    toolCalls: 0,
    async *stream(request) {
      const hasToolResult = request.messages.some((message) =>
        message.content.some((block) => block.type === "tool_result"),
      );
      yield { type: "request_started", provider: "tool-restart", model: "default" };
      yield { type: "message_start", role: "assistant" };
      if (!hasToolResult && (phase === "initial" || phase === "timeout" || phase === "abort")) {
        const calls = phase === "initial" ? [
          { id: "restart-read", name: "read_file", input: { file_path: "seed.txt" } },
          { id: "restart-write", name: "write_file", input: { file_path: "written.txt", content: "written by gateway tool\n" } },
          { id: "restart-bash", name: "bash", input: { command: "printf 'process side effect\\n' > process.txt", description: "record process side effect" } },
        ] : phase === "timeout" ? [
          { id: "restart-timeout", name: "bash", input: { command: "sleep 1; touch timeout-side-effect.txt", timeout: 1, description: "timeout side effect" } },
        ] : [
          { id: "restart-abort", name: "bash", input: { command: "sleep 2; touch abort-side-effect.txt", description: "abort side effect" } },
        ];
        this.toolCalls += calls.length;
        for (const call of calls) {
          yield { type: "tool_call_start", id: call.id, name: call.name };
          yield { type: "tool_call_end", toolCall: call };
        }
        yield { type: "message_end", finishReason: "tool_call" };
        onToolCallsEmitted?.();
        return;
      }
      yield { type: "text_delta", text: phase === "restart" ? "Restarted tool audit remains available." : "Tool work completed." };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: '{"title":"Tool audit"}' }],
        finishReason: "stop",
      };
    },
    getCapabilities() {
      return { supportsToolUse: true, maxContextTokens: 65_536, maxOutputTokens: 8_192 };
    },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl() { return undefined; },
  };
}

function toolResults(entries) {
  return durableToolResults(entries).map(({ step, result }) => ({ step, result: structuredClone(result) }));
}

function auditProjection(entries) {
  return durableToolResults(entries)
    .map(({ step, result }) => ({
      step,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      status: result.type === "success" ? "success" : "error",
      ...(result.type === "error" ? { errorCode: result.error.code } : {}),
    }));
}

function terminalProjection(entries) {
  const terminal = [...entries].reverse().find((entry) => entry.type === "turn_result");
  return terminal?.type === "turn_result"
    ? {
      type: terminal.result.type,
      stopReason: terminal.result.stopReason,
      ...(terminal.result.errors ? { errors: terminal.result.errors } : {}),
    }
    : undefined;
}

function durableToolResults(entries) {
  const messageResults = entries.flatMap((entry) => {
    if (entry.type !== "tool_result_message") return [];
    return entry.message.content.flatMap((block) => block.type === "tool_result" && block.raw
      ? [{ step: block.raw.timeline?.order ?? 0, result: block.raw }]
      : []);
  });
  if (messageResults.length > 0) return messageResults;
  return entries.flatMap((entry) => entry.type === "tool_result"
    ? [{ step: entry.step, result: entry.result }]
    : []);
}

function config() {
  return `schemaVersion: 1
agent:
  model: tool-restart/default
model:
  providers:
    tool-restart:
      protocol: openai
      url: http://unused.invalid/v1
      apiKey: test-only
      models:
        default:
          capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 8192 }
`;
}

function normalize(value, projectRoot) {
  if (typeof value === "string") return value.replaceAll(projectRoot, "<workspace>");
  if (Array.isArray(value)) return value.map((item) => normalize(item, projectRoot));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "startedAt" || key === "completedAt" || key === "durationMs" || key === "mtimeMs" || key === "turnId"
      ? "<time>"
      : normalize(child, projectRoot),
  ]));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
