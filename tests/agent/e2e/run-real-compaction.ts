import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createAgentSessionWithStorage,
  createInitialAgentSessionState,
} from "../../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import {
  actualInputTokensFromUsage,
  AutoCompactionPolicy,
  CompactionEngine,
  ContextOverflowRecovery,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  DefaultContextRuntime,
  MicroCompactionEngine,
  SnipEngine,
  TokenAccountingRuntime,
  TokenBudgetManager,
  type TokenBudgetSnapshot,
} from "../../../src/context/index.js";
import {
  createModelRuntime,
  type CanonicalMessage,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalUsage,
} from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { createRouterRuntime } from "../../../src/router/index.js";
import {
  createAgentProjectSessionStorage,
  readTranscript,
  replayTranscriptEntries,
} from "../../../src/session/index.js";
import type {
  AgentTranscriptEntry,
  CompactBoundaryMetadata,
} from "../../../src/session/transcript/TranscriptEntry.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

if (process.env.PILOTDECK_RUN_REAL_COMPACTION_E2E !== "1") {
  throw new Error("Set PILOTDECK_RUN_REAL_COMPACTION_E2E=1 to run the real-provider compaction E2E.");
}

const projectRoot = process.cwd();
const snapshot = loadPilotConfig({ projectRoot });
const selected = snapshot.config.agent.model;
const modelRuntime = createModelRuntime(snapshot.config.model);
const capabilities = modelRuntime.getCapabilities(selected.provider, selected.model);
const maxContextTokens = snapshot.config.agent.maxContextTokens ?? capabilities.maxContextTokens;
const maxOutputTokens = snapshot.config.agent.maxOutputTokens ?? capabilities.maxOutputTokens;
const effectiveInputTokens = Math.max(1, maxContextTokens - maxOutputTokens);
const targetTokens = Math.floor(effectiveInputTokens * 0.60);
const summaryMaxOutputTokens = 4_000;
const model = { provider: selected.provider, model: selected.model };
const tokenBudget = new TokenBudgetManager();
const tokenAccounting = new TokenAccountingRuntime({ modelConfig: snapshot.config.model });
const microCompaction = new MicroCompactionEngine({
  protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
});
const history = await buildRealRepositoryHistory({
  projectRoot,
  model,
  maxContextTokens,
  maxOutputTokens,
  tokenAccounting,
  microCompaction,
});
const initialSnapshot = await evaluateBudget(history.messages);
const projectedSnapshot = await evaluateBudget(history.projectedMessages);

const routerConfig = snapshot.config.router ?? {
  enabled: false,
  scenarios: { default: selected },
};
const router = createRouterRuntime(routerConfig, { modelRuntime });
let summaryCalls = 0;
let summaryUsage: CanonicalUsage | undefined;
const summaryPrompts: string[] = [];
const compactEvents: Array<Record<string, unknown>> = [];
const compactionEngine = new CompactionEngine({
  model: {
    async *stream(request, signal): AsyncIterable<CanonicalModelEvent> {
      summaryCalls += 1;
      summaryPrompts.push(textFromMessage(request.messages.at(-1)));
      for await (const event of router.stream(request, {
        sessionId: "real-compaction-e2e",
        turnId: "compact",
        projectPath: projectRoot,
        abortSignal: signal,
        isMainAgent: false,
      })) {
        if (event.type === "usage") summaryUsage = event.usage;
        yield event;
      }
    },
  },
  provider: selected.provider,
  model_: selected.model,
  tokenBudget,
  tokenAccounting,
  maxOutputTokens: summaryMaxOutputTokens,
  protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  eventEmitter: (event) => compactEvents.push(event as unknown as Record<string, unknown>),
});
const context = new DefaultContextRuntime({
  tokenBudget,
  compactionEngine,
  autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
  microCompaction,
  snipEngine: new SnipEngine({ protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES }),
  overflowRecovery: new ContextOverflowRecovery(),
  maxContextTokens,
  projectRoot,
});

const agentConfig: AgentRuntimeConfig = {
  provider: selected.provider,
  model: selected.model,
  cwd: projectRoot,
  maxContextTokens,
  maxOutputTokens,
  permissionMode: "bypassPermissions",
  permissionContext: createDefaultPermissionContext({
    cwd: projectRoot,
    mode: "bypassPermissions",
    canPrompt: false,
    bypassAvailable: true,
  }),
};
const runRoot = mkdtempSync(join(tmpdir(), "pilotdeck-real-compaction-e2e-"));
const sessionId = `real-compaction-${Date.now()}`;
const storage = createAgentProjectSessionStorage({
  projectRoot,
  pilotHome: runRoot,
  sessionId,
});
const seedTurnId = "seed-real-history";
await storage.transcript.recordAcceptedInput(sessionId, seedTurnId, history.messages);
await storage.transcript.recordTurnResult(sessionId, seedTurnId, {
  type: "success",
  sessionId,
  turnId: seedTurnId,
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
});

const initialState = createInitialAgentSessionState(sessionId);
initialState.messages = history.messages;
const { session } = createAgentSessionWithStorage({
  sessionId,
  config: agentConfig,
  storage,
  initialState,
  collectFileArtifacts: false,
  dependencies: {
    router,
    tools: { registry: new ToolRegistry() },
    context,
    tokenAccounting,
    getModelMaxContextTokens: (provider, modelId) => {
      try {
        return provider === selected.provider && modelId === selected.model
          ? maxContextTokens
          : modelRuntime.getCapabilities(provider, modelId).maxContextTokens;
      } catch {
        return undefined;
      }
    },
    getModelMaxOutputTokens: (provider, modelId) => {
      try {
        return modelRuntime.getCapabilities(provider, modelId).maxOutputTokens;
      } catch {
        return undefined;
      }
    },
    getModelTokenLimits: (provider, modelId) => {
      try {
        const caps = modelRuntime.getCapabilities(provider, modelId);
        return {
          maxContextTokens: provider === selected.provider && modelId === selected.model
            ? maxContextTokens
            : caps.maxContextTokens,
          maxOutputTokens: caps.maxOutputTokens,
        };
      } catch {
        return undefined;
      }
    },
    getModelProtocol: (provider) => modelRuntime.getProviderProtocol(provider),
    getModelSupportsPromptCache: (provider, modelId) => {
      try {
        return modelRuntime.getCapabilities(provider, modelId).supportsPromptCache;
      } catch {
        return undefined;
      }
    },
  },
});

const agentEvents: Array<Record<string, unknown>> = [];
for await (const event of session.submit(
  { type: "text", text: history.finalInstruction },
  { turnId: "real-compaction-turn", maxTurns: 1, permissionMode: "bypassPermissions", canPrompt: false },
)) {
  agentEvents.push(event as unknown as Record<string, unknown>);
}
const firstSnapshot = session.snapshot();
const firstRollingSummary = firstSnapshot.messages.find(isWrappedSummaryMessage);
assert.ok(firstRollingSummary, "the first compaction did not retain a rolling summary");
const summaryCallsAfterFirstPass = summaryCalls;
const firstTranscript = await readTranscript(storage.transcriptPath);
const firstBoundaryCount = compactBoundaryEntries(firstTranscript.entries).length;
assert.ok(firstBoundaryCount > 0, "the first compaction did not persist a compact boundary");

const secondAgentEvents: Array<Record<string, unknown>> = [];
for await (const event of session.submit(
  { type: "text", text: "Run a second rolling-summary continuity check." },
  {
    turnId: "real-compaction-turn-2",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    canPrompt: false,
    syntheticMessages: [
      ...history.messages,
      textMessage("user", "The second repository inspection is complete. Confirm completion in one short sentence and do not call tools."),
    ],
  },
)) {
  secondAgentEvents.push(event as unknown as Record<string, unknown>);
}
await router.shutdown();

const { entries } = await readTranscript(storage.transcriptPath);
const replay = replayTranscriptEntries(entries);
const compactBoundaries = compactBoundaryEntries(entries);
assert.ok(summaryCalls > summaryCallsAfterFirstPass, "the real summary model was not called for the second compaction");
assert.ok(
  summaryPrompts.slice(summaryCallsAfterFirstPass).some((prompt) =>
    prompt.includes("<previous-rolling-summary>")
      && prompt.includes("</previous-rolling-summary>")
      && prompt.includes("one complete replacement summary, not an addendum")
  ),
  "the second summary request did not include the first rolling summary",
);
assert.ok(compactBoundaries.length > firstBoundaryCount, "the second compact boundary was not persisted");
const finalSnapshotMessages = session.snapshot().messages;
assert.equal(finalSnapshotMessages.filter(isCompactBoundaryMessage).length, 1);
assert.equal(finalSnapshotMessages.filter(isWrappedSummaryMessage).length, 1);
const tokenCountSources = secondAgentEvents
  .filter((event) => event.type === "context_budget")
  .map((event) => String((event.snapshot as Record<string, unknown> | undefined)?.source));
assert.ok(tokenCountSources.length > 0, "the second turn did not emit token budget accounting");
assert.ok(tokenCountSources.every((source) => ["provider", "calibrated", "local"].includes(source)));

function compactBoundaryEntries(entriesToFilter: AgentTranscriptEntry[]) {
  return entriesToFilter.filter((entry): entry is AgentTranscriptEntry & {
    type: "control_boundary";
    boundary: { kind: "compact"; subtype: "compact_boundary"; compactMetadata: CompactBoundaryMetadata };
  } =>
    entry.type === "control_boundary"
      && entry.boundary.kind === "compact"
      && "subtype" in entry.boundary
      && entry.boundary.subtype === "compact_boundary"
  );
}
assert.ok(summaryCalls > 0, "real summary model was not called");
assert.ok(compactBoundaries.length > 0, "no compact boundary was persisted");
const compactMetadata = compactBoundaries.at(-1)!.boundary.compactMetadata;
assert.equal(compactMetadata.targetTokens, targetTokens);
assert.equal(compactMetadata.summaryGenerated, true);
assert.equal(compactMetadata.checkpointMerged, true);
assert.ok(
  typeof compactMetadata.postTokens === "number" && compactMetadata.postTokens <= targetTokens,
  `post-compaction prompt ${compactMetadata.postTokens} exceeded target ${targetTokens}`,
);
assert.ok(replay.lastCompactBoundary, "transcript replay did not select the persisted compact boundary");
assert.equal(
  replay.lastCompactBoundary.boundary.kind === "compact"
    && "compactMetadata" in replay.lastCompactBoundary.boundary
    ? replay.lastCompactBoundary.boundary.compactMetadata.compactionId
    : undefined,
  compactMetadata.compactionId,
);
const replacementMessages = replay.messages.filter((message) => message.metadata?.compactReplacement === true);
assert.ok(replacementMessages.length > 0, "replay did not retain replacement snapshot messages");
assert.ok(replacementMessages.every((message) =>
  message.metadata?.compactSnapshotId === compactMetadata.compactionId
));
const finalText = session.snapshot().messages
  .at(-1)?.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("\n") ?? "";
assert.ok(finalText.trim().length > 0, "real agent returned no final text");

const report = {
  provider: selected.provider,
  model: selected.model,
  sourceFiles: history.sourceFiles,
  seededMessages: history.messages.length,
  limits: {
    totalContextTokens: maxContextTokens,
    maxOutputTokens,
    effectiveInputTokens,
    targetTokens,
    summaryMaxOutputTokens,
  },
  initial: budgetReport(initialSnapshot),
  afterMicroProjection: budgetReport(projectedSnapshot),
  summaryCalls,
  summaryUsage,
  summaryInputUsageTokens: actualInputTokensFromUsage(summaryUsage),
  compactMetadata: compactMetadata as CompactBoundaryMetadata,
  compactEvents,
  agentEventTypes: agentEvents.map((event) => event.type),
  secondAgentEventTypes: secondAgentEvents.map((event) => event.type),
  tokenCountSources,
  replayMessages: replay.messages.length,
  replacementMessages: replacementMessages.length,
  finalTextPreview: finalText.slice(0, 500),
  transcriptPath: storage.transcriptPath,
};
const reportPath = resolve(runRoot, "real-compaction-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`report=${reportPath}\n`);

async function buildRealRepositoryHistory(input: {
  projectRoot: string;
  model: { provider: string; model: string };
  maxContextTokens: number;
  maxOutputTokens: number;
  tokenAccounting: TokenAccountingRuntime;
  microCompaction: MicroCompactionEngine;
}): Promise<{
  messages: CanonicalMessage[];
  projectedMessages: CanonicalMessage[];
  sourceFiles: number;
  finalInstruction: string;
}> {
  const finalInstruction =
    "The repository inspection is complete. Confirm completion in one short sentence and do not call any tools.";
  const candidates = execFileSync("rg", ["--files", "src", "tests"], {
    cwd: input.projectRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .sort();
  const sourcePool: Array<{ relativePath: string; content: string }> = [];
  for (const relativePath of candidates) {
    try {
      const content = readFileSync(resolve(input.projectRoot, relativePath), "utf8");
      if (content.length >= 4_000) sourcePool.push({ relativePath, content });
    } catch {
      // Ignore files that disappear during the live repository scan.
    }
    if (sourcePool.length >= 12) break;
  }
  assert.ok(sourcePool.length > 0, "no real repository source files were available for the E2E history");
  const messages: CanonicalMessage[] = [{
    role: "user",
    content: [{
      type: "text",
      text: "Inspect the PilotDeck context, compaction, agent loop, transcript, and model code paths, preserving concrete findings for a final status response.",
    }],
  }];
  let projectedMessages: CanonicalMessage[] = messages;
  let sourceFiles = 0;
  while (sourceFiles < 240) {
    const { relativePath, content } = sourcePool[sourceFiles % sourcePool.length]!;
    sourceFiles += 1;
    const toolCallId = `real-read-${sourceFiles}`;
    messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_call", id: toolCallId, name: "read_file", input: { path: relativePath } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId,
          content: [{ type: "text", text: content.slice(0, 24_000) }],
        }],
      },
    );
    if (sourceFiles % 5 !== 0) continue;
    projectedMessages = input.microCompaction.apply({
      messages: [...messages, textMessage("user", finalInstruction)],
      trimToTokens: 768,
    }).messages;
    const projected = await evaluateRequestBudget(input.tokenAccounting, {
      ...input.model,
      messages: projectedMessages,
      maxOutputTokens: input.maxOutputTokens,
      stream: true,
    }, input.maxContextTokens, input.maxOutputTokens);
    if (projected.ratio >= 0.96) break;
  }
  const projected = await evaluateRequestBudget(input.tokenAccounting, {
    ...input.model,
    messages: projectedMessages,
    maxOutputTokens: input.maxOutputTokens,
    stream: true,
  }, input.maxContextTokens, input.maxOutputTokens);
  assert.ok(projected.ratio >= 0.96, `real repository history only reached ratio ${projected.ratio.toFixed(3)}`);
  return { messages, projectedMessages, sourceFiles, finalInstruction };
}

async function evaluateBudget(messages: CanonicalMessage[]): Promise<TokenBudgetSnapshot> {
  return evaluateRequestBudget(tokenAccounting, {
    ...model,
    messages,
    maxOutputTokens,
    stream: true,
  }, maxContextTokens, maxOutputTokens);
}

function evaluateRequestBudget(
  accounting: TokenAccountingRuntime,
  request: CanonicalModelRequest,
  contextTokens: number,
  outputTokens: number,
): Promise<TokenBudgetSnapshot> {
  return accounting.evaluateRequestBudget(request, {
    maxContextTokens: contextTokens,
    reservedOutputTokens: outputTokens,
  });
}

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function textFromMessage(message: CanonicalMessage | undefined): string {
  return message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
}

function isCompactBoundaryMessage(message: CanonicalMessage): boolean {
  return message.role === "user" && textFromMessage(message).startsWith("<compact-boundary");
}

function isWrappedSummaryMessage(message: CanonicalMessage): boolean {
  return message.role === "assistant"
    && textFromMessage(message).startsWith("[CONTEXT COMPACTION - REFERENCE ONLY]");
}

function budgetReport(value: TokenBudgetSnapshot): Record<string, unknown> {
  return {
    tokens: value.tokens,
    totalContextTokens: value.totalContextTokens,
    effectiveContextTokens: value.effectiveContextTokens,
    reservedOutputTokens: value.reservedOutputTokens,
    ratio: value.ratio,
    source: value.source,
    exact: value.exact,
  };
}
