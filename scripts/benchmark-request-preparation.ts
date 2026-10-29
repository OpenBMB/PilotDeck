/** #688: real loop/context/tokenizer, deterministic history, no model/network/workspace scans. */
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CanonicalMessage } from "../src/model/index.js";
import type { AgentRouterRuntime } from "../src/agent/runtime/AgentRuntimeDependencies.js";

const { values } = parseArgs({ options: {
  "implementation-root": { type: "string" }, corpus: { type: "string" },
  fixture: { type: "string" },
  runs: { type: "string", default: "9" }, output: { type: "string" },
} });
const root = resolve(values["implementation-root"] ?? fileURLToPath(new URL("..", import.meta.url)));
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 3) throw new Error("--runs must be at least 3");
const load = <T>(file: string): Promise<T> => import(pathToFileURL(join(root, "src", file)).href);
const [{ AgentLoop }, { DefaultContextRuntime }, { TokenAccountingRuntime }, { TokenBudgetManager },
  { AutoCompactionPolicy }, { InstructionDiscovery }, { ToolRegistry }, { createDefaultPermissionContext }] = await Promise.all([
  load<typeof import("../src/agent/loop/AgentLoop.js")>("agent/loop/AgentLoop.ts"),
  load<typeof import("../src/context/DefaultContextRuntime.js")>("context/DefaultContextRuntime.ts"),
  load<typeof import("../src/context/budget/TokenAccountingRuntime.js")>("context/budget/TokenAccountingRuntime.ts"),
  load<typeof import("../src/context/budget/TokenBudgetManager.js")>("context/budget/TokenBudgetManager.ts"),
  load<typeof import("../src/context/compaction/AutoCompactionPolicy.js")>("context/compaction/AutoCompactionPolicy.ts"),
  load<typeof import("../src/context/instructions/InstructionDiscovery.js")>("context/instructions/InstructionDiscovery.ts"),
  load<typeof import("../src/tool/registry/ToolRegistry.js")>("tool/registry/ToolRegistry.ts"),
  load<typeof import("../src/permission/protocol/types.js")>("permission/protocol/types.ts"),
]);
// This default fixture never depends on the implementation being benchmarked.
const corpus = values.corpus ? await readFile(resolve(values.corpus), "utf8") : [
  "export async function prepareRequest(messages: Message[], tools: Tool[]) {",
  "  const context = await runtime.prepare({ messages, tools, previewOnly: true });",
  "  const estimate = accounting.estimate(context);",
  "  if (estimate > context.limit) return compact(context);",
  "  return { messages: context.messages, tools, systemPrompt: context.systemPrompt };",
  "}",
].join("\n");
if (!corpus.length) throw new Error("The corpus must not be empty");
const median = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
type Sample = { tokens: number; preExecutionMs: number; contextPreparations: number;
  localTokenizations: number; memoryRetrievals: number; instructionDiscoveries: number };
const results: Array<{ characters: number; routed: boolean; medianPreExecutionMs: number; samples: Sample[] }> = [];
const workspace = values.fixture ? resolve(values.fixture) : await mkdtemp(join(tmpdir(), "pilotdeck-request-benchmark-"));
// An explicit path makes cwd/instruction tokens identical across implementations.
// Refuse existing paths so cleanup can only remove a fixture created by this run.
if (values.fixture) await mkdir(workspace);
try {
  await writeFile(join(workspace, "PILOTDECK.md"), "Keep requests consistent with project rules.\n".repeat(120));
  new TokenBudgetManager().estimateTextTokens("Warm the tokenizer.");
  for (const [characters, routed] of [[6000, false], [90000, false], [700000, false], [90000, true]] as const) {
    const source = corpus.repeat(Math.ceil(characters / corpus.length)).slice(0, characters);
    const history: CanonicalMessage[] = [];
    for (let offset = 0; offset < source.length; offset += 4000) {
      history.push({ role: history.length % 2 ? "assistant" : "user", content: [{ type: "text", text: source.slice(offset, offset + 4000) }] });
    }
    history.push({ role: "user", content: [{ type: "text", text: "Explain the context preparation performance." }] });
    const samples: Sample[] = [];
    for (let run = 0; run < runs; run++) {
      let contextPreparations = 0, localTokenizations = 0, memoryRetrievals = 0, instructionDiscoveries = 0;
      let executionAt = 0, tokens = 0;
      const tokenBudget = new TokenBudgetManager();
      const estimateMessages = tokenBudget.estimateMessagesTokens.bind(tokenBudget);
      tokenBudget.estimateMessagesTokens = messages => { localTokenizations++; return estimateMessages(messages); };
      const discovery = new InstructionDiscovery(workspace, workspace, join(workspace, "home"));
      const discover = discovery.discover.bind(discovery);
      discovery.discover = async () => { instructionDiscoveries++; return discover(); };
      const context = new DefaultContextRuntime({ tokenBudget, maxContextTokens: 2_000_000,
        autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }), instructionDiscovery: discovery,
        memoryResolver: {
          retrieve: async () => { memoryRetrievals++; return { systemContext: "Project memory is immediately available.", diagnostics: [] }; },
          captureTurn: async () => {},
        },
      });
      const prepare = context.prepareForModel.bind(context);
      context.prepareForModel = async input => { contextPreparations++; return prepare(input); };
      const accounting = new TokenAccountingRuntime({ modelConfig: { providers: {} }, tokenBudget,
        fetch: async () => { throw new Error("Network forbidden in this benchmark"); },
      });
      const estimate = accounting.estimateRequestInput.bind(accounting);
      accounting.estimateRequestInput = (...args) => { tokens = estimate(...args); return tokens; };
      const registry = new ToolRegistry();
      for (let i = 0; i < 30; i++) registry.register({ name: `inspect_file_${i}`,
        description: "Inspect a project file and report matching source lines.", kind: "filesystem",
        inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] },
        isReadOnly: () => true, isConcurrencySafe: () => true, isDestructive: () => false,
        execute: async () => ({ content: [] }),
      });
      const router: AgentRouterRuntime = {
        invalidateSticky: () => ({ orchestrating: false }),
        decide: async ({ request }) => ({ provider: request.provider, model: routed ? "small" : "large",
          scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "explicit", mutations: {} }),
        materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
        execute: async function* () {
          executionAt = performance.now();
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "done" };
          yield { type: "message_end", finishReason: "stop" };
        },
        stream: async function* () { throw new Error("Unexpected stream"); },
      };
      const loop = new AgentLoop({ provider: "benchmark", model: "large", cwd: workspace, permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({ cwd: workspace, mode: "bypassPermissions", canPrompt: false, bypassAvailable: true }) },
      { router, context, tokenAccounting: accounting, tools: { registry, scheduler: { executeAll: async () => [] } },
        getModelTokenLimits: (_provider, model) => ({ maxContextTokens: model === "small" ? 1_000_000 : 2_000_000 }),
      });
      const start = performance.now();
      let compacted = false, success = false;
      for await (const event of loop.run({ sessionId: `benchmark-${run}`, turnId: "turn", messages: history })) {
        if (event.type === "turn_continued" && event.reason === "auto_compact") compacted = true;
        if (event.type === "turn_completed") success = event.result.type === "success";
      }
      if (!executionAt || compacted || !success) throw new Error("Invalid no-compaction sample");
      samples.push({ tokens, preExecutionMs: executionAt - start, contextPreparations, localTokenizations, memoryRetrievals, instructionDiscoveries });
    }
    const result = { characters, routed, medianPreExecutionMs: median(samples.slice(1).map(s => s.preExecutionMs)), samples };
    results.push(result);
    console.log(JSON.stringify({ ...result, samples: undefined, counts: samples.at(-1) }));
  }
  const output = { node: process.version, platform: process.platform, arch: process.arch, implementationRoot: root,
    runs, discardedWarmups: 1, corpus: values.corpus ?? "built-in deterministic fixture", results };
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(output, null, 2) + "\n");
} finally { await rm(workspace, { recursive: true, force: true }); }
