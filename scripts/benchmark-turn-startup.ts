/** Production turn/loop/tool pipeline + real workspace I/O; deterministic local model, no network. */
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import type { AgentRouterRuntime } from "../src/agent/runtime/AgentRuntimeDependencies.js";
import type { PilotDeckToolDefinition } from "../src/tool/protocol/types.js";

const { values } = parseArgs({ options: {
  workspace: { type: "string" }, "implementation-root": { type: "string" },
  runs: { type: "string", default: "7" }, output: { type: "string" },
  "model-delay-ms": { type: "string", default: "50" }, "pre-request-hook": { type: "boolean", default: false },
} });
const root = resolve(values["implementation-root"] ?? fileURLToPath(new URL("..", import.meta.url)));
const cwd = resolve(values.workspace ?? process.cwd()), runs = Number(values.runs), modelDelayMs = Number(values["model-delay-ms"]);
if (!Number.isSafeInteger(runs) || runs < 3 || !Number.isFinite(modelDelayMs) || modelDelayMs < 0) throw new Error("Invalid --runs or --model-delay-ms");
const load = (file: string) => import(pathToFileURL(join(root, "src", file)).href);
const [turn, agent, checkpoints, artifacts, transcript, toolRegistry, toolRuntime, scheduler, permissions, lifecycleModule, hookModule] = await Promise.all([
  load("agent/turn/TurnRunner.ts"), load("agent/loop/AgentLoop.ts"), load("session/checkpoints/WorkspaceCheckpoints.ts"),
  load("session/artifacts/FileArtifactCollector.ts"), load("session/transcript/InMemoryTranscriptWriter.ts"),
  load("tool/registry/ToolRegistry.ts"), load("tool/execution/ToolRuntime.ts"), load("tool/scheduler/ConcurrentToolScheduler.ts"),
  load("permission/index.ts"), load("lifecycle/index.ts"), load("extension/hooks/execution/HookRuntime.ts"),
]) as [typeof import("../src/agent/turn/TurnRunner.js"), typeof import("../src/agent/loop/AgentLoop.js"),
  typeof import("../src/session/checkpoints/WorkspaceCheckpoints.js"), typeof import("../src/session/artifacts/FileArtifactCollector.js"),
  typeof import("../src/session/transcript/InMemoryTranscriptWriter.js"), typeof import("../src/tool/registry/ToolRegistry.js"),
  typeof import("../src/tool/execution/ToolRuntime.js"), typeof import("../src/tool/scheduler/ConcurrentToolScheduler.js"),
  typeof import("../src/permission/index.js"), typeof import("../src/lifecycle/index.js"), typeof import("../src/extension/hooks/execution/HookRuntime.js")];
const home = await mkdtemp(join(tmpdir(), "pilotdeck-turn-startup-benchmark-"));
let acceptedAt = 0, preparationAt = 0, checkpointDurationMs = 0;
let scope = { entries: 0, protectedFiles: 0, protectedBytes: 0 };
const startArtifacts = artifacts.FileArtifactCollector.start;
artifacts.FileArtifactCollector.start = async function(options) {
  const collector = await startArtifacts.call(this, options);
  preparationAt = performance.now();
  return collector;
};
const originalCapture = checkpoints.CheckpointStore.prototype.capture;
checkpoints.CheckpointStore.prototype.capture = async function(...args) {
  const result = await originalCapture.apply(this, args);
  const files = Object.values(result.files);
  scope = { entries: files.length, protectedFiles: files.filter(file => file.kind === "file").length,
    protectedBytes: files.reduce((sum, file) => sum + (file.kind === "file" ? file.size : 0), 0) };
  return result;
};

type Sample = { run: number; case: string; entries: number; protectedFiles: number; protectedBytes: number;
  requestAfterAcceptedMs: number; firstTokenAfterAcceptedMs: number; preparationAfterAcceptedMs: number;
  firstToolAfterAcceptedMs: number; turnCompletedAfterAcceptedMs: number; checkpointDurationMs: number;
  requestBeforePreparation: boolean; toolAfterPreparation: boolean };
const samples: Sample[] = [];
try {
  for (let run = 1; run <= runs; run++) {
    let requestAt: number | undefined, tokenAt: number | undefined, toolAt: number | undefined, requests = 0, workspaceChanged = false;
    preparationAt = 0;
    const registry = new toolRegistry.ToolRegistry();
    const probe: PilotDeckToolDefinition = {
      name: "workspace_probe", description: "A potentially mutating operation with a no-op benchmark body.",
      kind: "filesystem",
      inputSchema: { type: "object", properties: {} }, isReadOnly: () => false,
      isConcurrencySafe: () => false, isDestructive: () => false,
      execute: async () => { toolAt = performance.now(); return { content: [{ type: "text", text: "done" }] }; },
    };
    registry.register(probe);
    const router: AgentRouterRuntime = {
      invalidateSticky: () => ({ orchestrating: false }),
      decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default",
        isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
      execute: async function* (_decision, _request, context) {
        requestAt ??= performance.now(); requests++;
        await setTimeout(modelDelayMs, undefined, { signal: context.abortSignal });
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "Starting the answer." };
        if (requests === 1) {
          yield { type: "tool_call_start", id: "probe", name: probe.name };
          yield { type: "tool_call_end", toolCall: { id: "probe", name: probe.name, input: {} } };
        }
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: "message_end", finishReason: requests === 1 ? "tool_call" : "stop" };
      },
      stream: async function* () { throw new Error("Unexpected model stream"); },
    };
    const permissionContext = permissions.createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true });
    const hooks = new hookModule.HookRuntime(values["pre-request-hook"]
      ? { UserPromptSubmit: [{ hooks: [{ type: "callback", name: "baseline-required" }] }] } : {});
    hooks.getCallbackExecutor().register("baseline-required", () => {});
    const lifecycle = new lifecycleModule.LifecycleRuntime(hooks);
    const history = new checkpoints.WorkspaceCheckpoints(cwd, home);
    const begin = history.beginTurn.bind(history);
    history.beginTurn = async (...args) => { const start = performance.now(); await begin(...args); checkpointDurationMs = performance.now() - start; };
    const finish = history.finishTurn.bind(history);
    history.finishTurn = async status => { const checkpoint = await finish(status); workspaceChanged ||= !!checkpoint?.changes.length; return checkpoint; };
    const runtime = new toolRuntime.ToolRuntime(registry, new permissions.PermissionRuntime(), lifecycle);
    const loop = new agent.AgentLoop({ provider: "benchmark", model: "local-fixed-delay", cwd, permissionMode: "bypassPermissions", permissionContext },
      { router, lifecycle, fileHistory: history, tools: { registry, scheduler: new scheduler.ConcurrentToolScheduler(runtime, registry) } });
    const runner = new turn.TurnRunner(loop, new transcript.InMemoryTranscriptWriter(), undefined, undefined, lifecycle,
      { cwd, transcriptPath: "" }, { fileHistory: history });
    let succeeded = false;
    for await (const event of runner.run({ sessionId: "benchmark", turnId: `turn-${run}`, messages: [], input: { type: "text", text: "Answer and run the probe." } })) {
      if (event.type === "input_accepted") acceptedAt = performance.now();
      if (event.type === "model_event" && event.event.type === "text_delta") tokenAt ??= performance.now();
      if (event.type === "turn_completed") succeeded = event.result.type === "success";
    }
    if (!succeeded || requestAt === undefined || tokenAt === undefined || toolAt === undefined || !preparationAt) throw new Error("Incomplete benchmark turn");
    if (workspaceChanged) throw new Error("Workspace changed during the benchmark; repeat with an unchanged target.");
    if (toolAt < preparationAt) throw new Error("Unprotected tool execution detected");
    const sample = { run, case: run === 1 ? "initial-backup" : "unchanged", ...scope,
      requestAfterAcceptedMs: requestAt - acceptedAt, firstTokenAfterAcceptedMs: tokenAt - acceptedAt,
      preparationAfterAcceptedMs: preparationAt - acceptedAt, firstToolAfterAcceptedMs: toolAt - acceptedAt,
      turnCompletedAfterAcceptedMs: performance.now() - acceptedAt, checkpointDurationMs,
      requestBeforePreparation: requestAt < preparationAt, toolAfterPreparation: toolAt >= preparationAt };
    samples.push(sample); console.log(JSON.stringify(sample));
  }
  const median = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const keys = ["requestAfterAcceptedMs", "firstTokenAfterAcceptedMs", "preparationAfterAcceptedMs", "firstToolAfterAcceptedMs", "turnCompletedAfterAcceptedMs"] as const;
  const result = { node: process.version, platform: process.platform, arch: process.arch, workspace: cwd, implementationRoot: root,
    modelDelayMs, preRequestHook: values["pre-request-hook"], samples,
    unchangedMedian: Object.fromEntries(keys.map(key => [key, median(samples.slice(1).map(sample => sample[key]))])) };
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ unchangedMedian: result.unchangedMedian }));
} finally { await rm(home, { recursive: true, force: true }); }
