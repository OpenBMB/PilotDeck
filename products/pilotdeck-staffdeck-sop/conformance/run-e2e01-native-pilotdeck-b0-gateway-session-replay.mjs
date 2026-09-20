#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";
const tracePath = process.argv[2];

if (!tracePath) {
  throw new Error("Usage: run-e2e01-native-pilotdeck-b0-gateway-session-replay.mjs <e2e01-native-owner-trace.json>");
}

const trace = JSON.parse(await readFile(tracePath, "utf8"));
assert.equal(trace.scenario, "E2E-01-native-owner");
const expectedCalls = savedToolCalls(trace);
assert.deepEqual(expectedCalls.slice(0, 3).map((call) => call.name), ["read_skill", "read_file", "knowledge_query"]);
assert.equal(trace.compaction?.automatic?.boundary?.compactMetadata?.trigger, "auto", "saved E2E-01 trace has no automatic compact boundary");
assert.ok(trace.compaction?.automatic?.trigger, "saved E2E-01 trace has no automatic-compaction trigger observation");

const root = await mkdtemp(join(tmpdir(), "pilotdeck-e2e01-b0-gateway-"));
let report;
let failure;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
try {
  const [{ createLocalGateway }, { createAgentProjectSessionStorage, replayTranscriptEntries }] = await Promise.all([
    import(pathToFileURL(join(b0Root, "dist/src/cli/createLocalGateway.js")).href),
    import(pathToFileURL(join(b0Root, "dist/src/session/index.js")).href),
  ]);
  const projectRoot = join(root, "project");
  const sessionKey = "b0-e2e01-gateway";
  await mkdir(join(projectRoot, ".pilotdeck", "skills", "approval-guide"), { recursive: true });
  await writeFile(join(projectRoot, "approval-input.txt"), trace.sideEffects.readFile.content, "utf8");
  await writeFile(join(projectRoot, ".pilotdeck", "skills", "approval-guide", "SKILL.md"), [
    "---",
    "name: approval-guide",
    "description: Approval evidence guide",
    "---",
    "",
    trace.sideEffects.projectSkill.content,
  ].join("\n"), "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), b0Config(), "utf8");

  const model = createReplayModel(expectedCalls);
  const gateway = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    extraTools: [knowledgeTool(trace)],
    __testModelFactory: () => model,
  });
  try {
    const initialEvents = await submit(gateway.gateway, sessionKey, projectRoot, "Read the approval file and request operator approval.");
    assert.equal(initialEvents.some((event) => event.type === "turn_completed"), true);
    compareGatewayCalls(expectedCalls, savedToolCallsFromRequests(model.requests));
    compareGatewayResults(trace, model.requests, projectRoot);

    const independentBudget = await replayIndependentBudgetEvaluations(b0Root, trace);
    const compaction = await replaySavedAutomaticCompaction(b0Root, trace);
    const postCompactionGateway = process.env.PILOTDECK_E2E_POST_COMPACTION_REPLAY === "1"
      ? await replayPostCompactionGateway({
          root: b0Root,
          traceValue: trace,
          createLocalGateway,
          createAgentProjectSessionStorage,
          replayTranscriptEntries,
        })
      : {
          status: "NOT_RUN",
          command: "PILOTDECK_E2E_POST_COMPACTION_REPLAY=1 node products/pilotdeck-staffdeck-sop/conformance/run-e2e01-native-pilotdeck-b0-gateway-session-replay.mjs <trace>",
          knownDivergence: "B0 direct replay does not project atomic replacementMessages; legacy mapping then exposes the candidate-only runtime-context contribution.",
        };

    if (process.env.PILOTDECK_E2E_GATEWAY_REPLAY_INJECT_MISMATCH === "1") {
      const altered = structuredClone(savedToolCallsFromRequests(model.requests));
      altered[0].input.skillName = "injected-mismatch";
      compareGatewayCalls(expectedCalls, altered);
    }
    report = {
      status: "PASS",
      baseline: b0Root,
      trace: tracePath,
      replayed: [
        "B0 createLocalGateway session entrypoint with the saved read_skill, read_file, and knowledge_query requests",
        "B0 native Skill and Tool execution through a real Gateway turn",
        "B0 DefaultContextRuntime replayed from the saved automatic-compaction input and budget evaluations",
      ],
      notCovered: [
        "StaffDeck Knowledge and SOP owner state, covered by run_e2e01_native_staffdeck_b0_replay.py",
        "B0 direct atomic compact-boundary replay: the fixed baseline has no replacementMessages projection",
        "Full post-compaction canonical request parity (system prompt, tools, cache plan), including source-tree built-in contribution drift",
        "An actual child-process termination between native summary completion and compact-boundary commit",
      ],
      compaction,
      independentBudget,
      postCompactionGateway,
    };
  } finally {
    await gateway.dispose();
  }
} catch (error) {
  failure = error;
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

if (failure) {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    baseline: b0Root,
    trace: tracePath,
    error: failure instanceof Error ? failure.message : String(failure),
  }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function b0Config() {
  return `schemaVersion: 1
agent:
  model: native-owner/default
model:
  providers:
    native-owner:
      protocol: openai
      url: http://unused.invalid/v1
      apiKey: test-only
      models:
        default:
          capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 8192 }
`;
}

function knowledgeTool(traceValue) {
  const content = traceValue.knowledge?.citation?.content;
  const schema = savedToolSchema(traceValue, "knowledge_query");
  assert.equal(typeof content, "string");
  return {
    name: "knowledge_query",
    description: schema?.description ?? "Query the saved approval-policy knowledge owner fixture.",
    kind: "custom",
    inputSchema: schema?.inputSchema ?? { type: "object", additionalProperties: true },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const expected = savedToolCalls(traceValue).find((call) => call.name === "knowledge_query");
      assert.deepEqual(input, expected?.input, "B0 Gateway changed the saved knowledge_query request");
      return { content: [{ type: "text", text: content }] };
    },
  };
}

function createReplayModel(calls) {
  return {
    requests: [],
    calls: calls.slice(0, 3),
    async *stream(request) {
      this.requests.push(request);
      yield { type: "request_started", provider: "native-owner", model: "default" };
      yield { type: "message_start", role: "assistant" };
      const hasToolResult = request.messages.some((message) => message.content.some((block) => block.type === "tool_result"));
      if (!hasToolResult) {
        for (const call of this.calls) {
          yield { type: "tool_call_start", id: call.id, name: call.name };
          yield { type: "tool_call_end", toolCall: call };
        }
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "Approval history recorded." };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: '{"title":"Approval policy"}' }],
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

async function replayPostCompactionGateway({ root, traceValue, createLocalGateway, createAgentProjectSessionStorage, replayTranscriptEntries }) {
  const saved = traceValue.compaction?.automatic;
  const restart = saved?.restart;
  assert.ok(restart && typeof restart === "object", "saved automatic compaction has no restart surface");
  assert.ok(Array.isArray(restart.transcriptEntries) && restart.transcriptEntries.length > 0, "saved automatic compaction has no durable transcript");
  assert.equal(
    restart.compactBoundaryCountAfterRestart,
    restart.compactBoundaryCountBeforeRestart,
    "candidate restart changed the compact-boundary count",
  );
  const autoReplacementBoundaryCount = restart.transcriptEntries.filter((entry) => entry?.type === "control_boundary"
    && entry.boundary?.kind === "compact"
    && entry.boundary?.subtype === "compact_boundary"
    && entry.boundary?.compactMetadata?.trigger === "auto"
    && Array.isArray(entry.boundary?.replacementMessages)
    && entry.boundary.replacementMessages.length > 0).length;
  assert.ok(autoReplacementBoundaryCount > 0, "candidate did not persist an automatic replacement compact boundary before restart");
  assert.equal(typeof restart.postMessage, "string", "saved automatic compaction has no post-restart message");
  assert.ok(restart.postRequest && typeof restart.postRequest === "object", "saved automatic compaction has no post-restart request");

  const replayRoot = await mkdtemp(join(tmpdir(), "pilotdeck-e2e01-b0-post-compact-"));
  const projectRoot = join(replayRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  const sessionKey = "native-owner-seven-slot";
  try {
    await mkdir(join(projectRoot, ".pilotdeck", "skills", "approval-guide"), { recursive: true });
    await writeFile(join(projectRoot, "approval-input.txt"), traceValue.sideEffects.readFile.content, "utf8");
    await writeFile(join(projectRoot, ".pilotdeck", "skills", "approval-guide", "SKILL.md"), [
      "---",
      "name: approval-guide",
      "description: Approval evidence guide",
      "---",
      "",
      traceValue.sideEffects.projectSkill.content,
    ].join("\n"), "utf8");
    await writeFile(join(projectRoot, "pilotdeck.yaml"), b0Config(), "utf8");
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: sessionKey });
    await mkdir(dirname(storage.transcriptPath), { recursive: true });
    const restoredEntries = replaceWorkspaceMarker(restart.transcriptEntries, projectRoot);
    const directReplay = replayTranscriptEntries(restoredEntries);
    const legacyEntries = projectLegacyCompactReplacement(restoredEntries);
    await writeFile(storage.transcriptPath, `${legacyEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const model = createPostCompactionReplayModel();
    const gateway = createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      fallbackProjectRoot: projectRoot,
      permissionMode: "bypassPermissions",
      extraTools: [knowledgeTool(traceValue), traceTool(traceValue, "submit_step_result")],
      __testModelFactory: () => model,
    });
    try {
      const events = await submit(gateway.gateway, sessionKey, projectRoot, restart.postMessage);
      assert.equal(events.some((event) => event.type === "turn_completed"), true, "B0 post-compaction Gateway turn did not complete");
      assert.equal(model.requests.length, 1, "B0 post-compaction Gateway turn did not issue exactly one model request");
      const actualRequest = model.requests[0];
      assert.ok(actualRequest, "B0 post-compaction Gateway turn produced no canonical request");
      comparePostCompactionCanonicalRequest(
        restart.postRequest,
        actualRequest,
        replayRoot,
        root,
        process.env.PILOTDECK_CANDIDATE_ROOT ?? process.cwd(),
      );
      return {
        compared: ["candidate durable compact-boundary transcript", "B0 legacy compact-replacement projection", "post-restart ordinary Gateway canonical request"],
        compactBoundaryCount: restart.compactBoundaryCountAfterRestart,
        autoReplacementBoundaryCount,
        modelRequestMessageCount: actualRequest.messages.length,
        directB0AtomicReplayMessageCount: directReplay.messages.length,
        candidatePostRequestMessageCount: restart.postRequest.messages.length,
      };
    } finally {
      await gateway.dispose();
    }
  } finally {
    await rm(replayRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createPostCompactionReplayModel() {
  return {
    requests: [],
    async *stream(request) {
      this.requests.push(request);
      yield { type: "request_started", provider: "native-owner", model: "default" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "B0 post-compaction history recorded." };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "B0 post-compaction summary." }],
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

function traceTool(traceValue, name) {
  const schema = savedToolSchema(traceValue, name);
  assert.ok(schema, `saved E2E-01 trace has no ${name} tool schema`);
  return {
    name: schema.name,
    description: schema.description,
    kind: "custom",
    inputSchema: schema.inputSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute() {
      return { content: [{ type: "text", text: `${name} is not invoked by the post-compaction replay.` }] };
    },
  };
}

function savedToolSchema(traceValue, name) {
  const requests = [
    traceValue.compaction?.automatic?.restart?.postRequest,
    ...(traceValue.modelRequests ?? []),
  ];
  for (const request of requests) {
    const schema = request?.tools?.find((tool) => tool?.name === name);
    if (schema) return schema;
  }
  return undefined;
}

function projectLegacyCompactReplacement(entries) {
  const projected = [];
  for (const entry of entries) {
    if (entry?.type !== "control_boundary" || entry.boundary?.kind !== "compact"
      || entry.boundary?.subtype !== "compact_boundary" || !Array.isArray(entry.boundary.replacementMessages)) {
      projected.push(entry);
      continue;
    }
    const { replacementMessages, ...legacyBoundary } = entry.boundary;
    projected.push({ ...entry, boundary: legacyBoundary });
    for (const message of replacementMessages) {
      projected.push({
        type: "durable_message",
        sessionId: entry.sessionId,
        turnId: entry.turnId,
        sequence: 0,
        createdAt: entry.createdAt,
        message,
      });
    }
  }
  return projected.map((entry, index) => ({ ...entry, sequence: index + 1 }));
}

function comparePostCompactionCanonicalRequest(expected, actual, workspacePath, baselineRoot, candidateRoot) {
  const normalizedActual = normalizeJsonSurface(normalizeWorkspacePath(
    normalizeWorkspacePath(
      normalizeWorkspacePath(actual, workspacePath),
      `/private${baselineRoot}`,
    ),
    baselineRoot,
  ));
  if (process.env.PILOTDECK_E2E_POST_COMPACTION_REQUEST_INJECT_MISMATCH === "1") {
    const lastMessage = normalizedActual.messages?.at(-1);
    if (lastMessage?.content?.[0]?.type === "text") {
      lastMessage.content[0].text = "injected post-compaction request mismatch";
    }
  }
  const normalizedExpected = normalizeJsonSurface(normalizeWorkspacePath(
    normalizeWorkspacePath(expected, workspacePath),
    candidateRoot,
  ));
  assert.deepEqual(
    normalizedActual,
    normalizedExpected,
    `B0 post-compaction Gateway canonical request differs from the saved candidate request; ${canonicalRequestDifferenceSummary(normalizedExpected, normalizedActual)}`,
  );
}

function canonicalRequestDifferenceSummary(expected, actual) {
  const keys = [...new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])];
  const differingKeys = keys.filter((key) => JSON.stringify(expected?.[key]) !== JSON.stringify(actual?.[key]));
  return JSON.stringify({
    differingKeys,
    expectedKeys: Object.keys(expected ?? {}),
    actualKeys: Object.keys(actual ?? {}),
    expectedCwd: String(expected?.systemPrompt ?? "").match(/cwd:.*(?:\\n|$)/)?.[0],
    actualCwd: String(actual?.systemPrompt ?? "").match(/cwd:.*(?:\\n|$)/)?.[0],
    expectedToolNames: expected?.tools?.map((tool) => tool?.name),
    actualToolNames: actual?.tools?.map((tool) => tool?.name),
  });
}

function normalizeWorkspacePath(value, workspacePath) {
  if (typeof value === "string") return value.replaceAll(workspacePath, "<workspace>");
  if (Array.isArray(value)) return value.map((item) => normalizeWorkspacePath(item, workspacePath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeWorkspacePath(item, workspacePath)]));
}

async function replaySavedAutomaticCompaction(root, traceValue) {
  const saved = restoreAutomaticCompactionWorkspace(traceValue.compaction?.automatic);
  assert.ok(saved && typeof saved === "object", "saved E2E-01 trace has no automatic-compaction surface");
  if (Array.isArray(saved.attempts) && saved.attempts.length > 0) {
    const attempts = [];
    for (const [index, attempt] of saved.attempts.entries()) {
      attempts.push(await replayOneAutomaticCompaction(root, traceValue, {
        index,
        trigger: attempt.trigger,
        request: attempt.summaryRequest,
        boundary: attempt.boundary,
        outcome: attempt.outcome,
      }));
    }
    return {
      compared: ["every causally recorded automatic/reactive attempt", "automatic outcomes", "persisted boundaries where present"],
      attempts,
    };
  }
  const triggers = Array.isArray(saved.triggers) ? saved.triggers : [saved.trigger];
  const requests = Array.isArray(saved.summaryRequests) ? saved.summaryRequests : [saved.summaryRequest];
  const boundaries = Array.isArray(saved.boundaries) ? saved.boundaries : [saved.boundary];
  assert.equal(triggers.length, requests.length, "saved automatic compaction trigger/request attempt count differs");
  assert.equal(requests.length, boundaries.length, "saved automatic compaction request/boundary attempt count differs");
  const attempts = [];
  for (let index = 0; index < triggers.length; index += 1) {
    attempts.push(await replayOneAutomaticCompaction(root, traceValue, {
      index,
      trigger: triggers[index],
      request: requests[index],
      boundary: boundaries[index],
    }));
  }
  return {
    compared: ["every saved automatic-compaction trigger", "every summary request", "every summary response and replacement surface"],
    attempts,
  };
}

async function replayOneAutomaticCompaction(root, traceValue, attempt) {
  const { index, trigger, request, boundary } = attempt;
  assert.ok(trigger && typeof trigger === "object", "saved automatic compaction has no trigger observation");
  assert.ok(request && typeof request === "object", "saved automatic compaction has no summary request");
  const autoStatus = attempt.outcome?.autoStatus ?? "success";
  const compactionTrigger = boundary?.compactMetadata?.trigger ?? (autoStatus === "success" ? "auto" : "reactive");
  assert.ok(compactionTrigger === "auto" || compactionTrigger === "reactive");
  assert.ok(boundary?.kind === "compact" && boundary.subtype === "compact_boundary", "saved compaction attempt has no compact boundary");
  assert.equal(boundary.compactMetadata?.trigger, compactionTrigger);
  assert.equal(request.maxOutputTokens, compactionTrigger === "reactive" ? 1_536 : 4_000);
  const summaryControl = request.messages?.at(-1);
  assert.equal(summaryControl?.metadata?.purpose, "context-summary-control");
  const triggerInput = trigger.input;
  const budgetEvaluations = trigger.budgetEvaluations;
  assert.ok(triggerInput && typeof triggerInput === "object", "saved automatic compaction has no raw Context input");
  assert.ok(Array.isArray(budgetEvaluations) && budgetEvaluations.length > 0, "saved automatic compaction has no budget evaluations");
  assert.deepEqual(
    normalizeJsonSurface(budgetEvaluations[0].messages),
    normalizeJsonSurface(triggerInput.messages),
    "saved trigger snapshot does not describe the raw Context input",
  );

  const {
    AutoCompactionPolicy,
    CompactionEngine,
    ContextOverflowRecovery,
    DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    DefaultContextRuntime,
    MicroCompactionEngine,
    SnipEngine,
    TokenAccountingRuntime,
    TokenBudgetManager,
  } = await import(pathToFileURL(join(root, "dist/src/context/index.js")).href);
  const requests = [];
  const responseText = boundary
    ? summaryTextFromBoundary(boundary)
    : summaryTextFromBudgetEvaluation(budgetEvaluations.at(-1));
  const tokenBudget = new TokenBudgetManager();
  const tokenAccounting = new TokenAccountingRuntime({ modelConfig: { providers: {} }, tokenBudget });
  const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
  const initialDecision = autoCompactionPolicy.evaluateSnapshot(structuredClone(trigger.snapshot));
  assert.deepEqual(
    normalizeJsonSurface(initialDecision),
    normalizeJsonSurface(trigger.decision),
    "B0 automatic-compaction trigger decision differs from the saved candidate decision",
  );
  const engine = new CompactionEngine({
    provider: request.provider,
    model_: request.model,
    maxOutputTokens: 4_000,
    model: {
      async *stream(value) {
        requests.push(value);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: responseText };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    tokenBudget,
    tokenAccounting,
  });
  let budgetEvaluationIndex = 0;
  const context = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy,
    compactionEngine: engine,
    microCompaction: new MicroCompactionEngine({ protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES }),
    snipEngine: new SnipEngine({ protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES }),
    overflowRecovery: new ContextOverflowRecovery(),
    maxContextTokens: triggerInput.maxContextTokens,
  });
  const replay = await context.tryAutoCompact({
    ...structuredClone(triggerInput),
    budgetEvaluator: async (messages) => {
      const expected = budgetEvaluations[budgetEvaluationIndex++];
      assert.ok(expected, "B0 Context requested more budget evaluations than the saved candidate trace");
      assert.deepEqual(
        normalizeJsonSurface(messages),
        normalizeJsonSurface(expected.messages),
        `B0 Context budget candidate ${budgetEvaluationIndex} differs from the saved candidate surface`,
      );
      return structuredClone(expected.snapshot);
    },
  });
  assert.equal(budgetEvaluationIndex, budgetEvaluations.length, "B0 Context skipped a saved budget evaluation");
  assert.equal(requests.length, 1, "B0 compaction replay did not make exactly one summary request");
  compareCompactionRequest(request, requests[0]);
  assert.equal(replay.type, "compacted");
  assert.equal(replay.result?.trigger, compactionTrigger);
  assert.equal(replay.result?.messagesSummarized, boundary.compactMetadata.messagesSummarized);
  assert.deepEqual(
    normalizeSummaryMessage(replay.result?.summaryMessage),
    normalizeSummaryMessage(summaryMessageFromBoundary(boundary)),
    "B0 compaction summary content differs from the saved candidate replacement",
  );
  const replacementMessages = structuredClone(replay.messages ?? triggerInput.messages);

  if (process.env.PILOTDECK_E2E_COMPACTION_REPLAY_INJECT_MISMATCH === "1") {
    const altered = structuredClone(requests[0]);
    altered.maxOutputTokens = Number(altered.maxOutputTokens) + 1;
    compareCompactionRequest(request, altered);
  }
  if (process.env.PILOTDECK_E2E_COMPACTION_REPLACEMENT_INJECT_MISMATCH === "1") {
    replacementMessages[0] = {
      ...replacementMessages[0],
      content: [{ type: "text", text: "injected replacement mismatch" }],
    };
  }
  assert.deepEqual(
    normalizeCompactReplacementMessages(replacementMessages),
    normalizeCompactReplacementMessages(boundary.replacementMessages),
    "B0 compaction replacement surface differs from the saved candidate boundary",
  );
  if (process.env.PILOTDECK_E2E_COMPACTION_TRIGGER_INJECT_MISMATCH === "1") {
    const altered = structuredClone(initialDecision);
    altered.snapshot.maxContextTokens = Number(altered.snapshot.maxContextTokens) + 1;
    assert.deepEqual(normalizeJsonSurface(altered), normalizeJsonSurface(trigger.decision));
  }

  return {
    index,
    compared: ["policy decision under the saved trigger snapshot", "Context branch and message candidates under the saved budget-evaluation sequence", "compaction outcome", "summary request", "messages summarized", "summary message", "replacement surface"],
    b0PostCompactMessageCount: replay.messages.length,
    unverified: ["durable boundary persistence", "next Gateway model request"],
  };
}

async function replayIndependentBudgetEvaluations(root, traceValue) {
  const saved = restoreAutomaticCompactionWorkspace(traceValue.compaction?.automatic);
  const triggers = Array.isArray(saved.triggers) ? saved.triggers : [saved.trigger];
  const attemptEvaluations = triggers.map((trigger, attempt) => {
    const input = trigger?.input;
    const evaluations = trigger?.budgetEvaluations;
    assert.ok(input && typeof input === "object", `saved automatic attempt ${attempt} has no Context input for budget replay`);
    assert.ok(Array.isArray(evaluations) && evaluations.length > 0, `saved automatic attempt ${attempt} has no budget evaluations for independent replay`);
    for (const [index, evaluation] of evaluations.entries()) {
      assert.ok(evaluation?.request && typeof evaluation.request === "object", `saved automatic budget evaluation ${attempt}/${index} has no canonical request`);
      assert.equal(typeof evaluation.maxContextTokens, "number", `saved automatic budget evaluation ${attempt}/${index} has no context window`);
      assert.equal(typeof evaluation.reservedOutputTokens, "number", `saved automatic budget evaluation ${attempt}/${index} has no output reserve`);
      assert.ok(evaluation.snapshot && typeof evaluation.snapshot === "object", `saved automatic budget evaluation ${attempt}/${index} has no snapshot`);
    }
    return evaluations;
  });

  const { TokenAccountingRuntime } = await import(pathToFileURL(join(root, "dist/src/context/index.js")).href);
  const accounting = new TokenAccountingRuntime({
    modelConfig: accountingModelConfig(attemptEvaluations.flat().map((evaluation) => evaluation.request)),
  });
  const replays = [];
  for (const [attempt, evaluations] of attemptEvaluations.entries()) {
    const postEvaluationIndex = evaluations.findIndex((evaluation, index) => index > 0
      && evaluation.snapshot?.state === evaluations[0]?.snapshot?.state);
    assert.ok(postEvaluationIndex > 0, `saved automatic attempt ${attempt} has no post-initial snapshot in the same policy branch`);
    for (const [index, evaluation] of evaluations.entries()) {
      const actualSnapshot = await accounting.evaluateRequestBudget(evaluation.request, {
        maxContextTokens: evaluation.maxContextTokens,
        reservedOutputTokens: evaluation.reservedOutputTokens,
        ...(evaluation.calibration ? { calibration: evaluation.calibration } : {}),
      });
      const comparableExpected = comparableBudgetSnapshot(evaluation.snapshot);
      if (process.env.PILOTDECK_E2E_BUDGET_REPLAY_INJECT_MISMATCH === "1" && attempt === 0 && index === 0) {
        comparableExpected.tokens += 1;
      }
      if (process.env.PILOTDECK_E2E_BUDGET_REPLAY_INJECT_POST_MISMATCH === "1" && attempt === 0 && index === postEvaluationIndex) {
        comparableExpected.tokens += 1;
      }
      assert.deepEqual(
        comparableBudgetSnapshot(actualSnapshot),
        comparableExpected,
        `B0 independently calculated automatic budget ${attempt}/${index} differs from the saved candidate snapshot`,
      );
      replays.push({ attempt, index, tokens: actualSnapshot.tokens, state: actualSnapshot.state });
    }
  }
  return {
    compared: ["every saved canonical candidate request", "context window", "output reserve", "calibration", "every automatic-compaction attempt and budget snapshot"],
    replays,
  };
}

function accountingModelConfig(requests) {
  const providers = {};
  for (const request of requests) {
    assert.equal(typeof request.provider, "string", "saved budget request has no provider");
    assert.equal(typeof request.model, "string", "saved budget request has no model");
    const provider = providers[request.provider] ?? {
      id: request.provider,
      protocol: "openai",
      url: "http://unused.invalid/v1",
      apiKey: "test-only",
      models: {},
    };
    provider.models[request.model] = { id: request.model };
    providers[request.provider] = provider;
  }
  return {
    providers,
  };
}

function comparableBudgetSnapshot(snapshot) {
  return {
    tokens: snapshot.tokens,
    localEstimateTokens: snapshot.localEstimateTokens,
    estimateSource: snapshot.estimateSource,
    totalContextTokens: snapshot.totalContextTokens,
    maxContextTokens: snapshot.maxContextTokens,
    effectiveContextTokens: snapshot.effectiveContextTokens,
    maxOutputTokens: snapshot.maxOutputTokens,
    warningRatio: snapshot.warningRatio,
    blockingRatio: snapshot.blockingRatio,
    state: snapshot.state,
    ratio: snapshot.ratio,
    source: snapshot.source,
    exact: snapshot.exact,
    reservedOutputTokens: snapshot.reservedOutputTokens,
    calibrationActualInputTokens: snapshot.calibrationActualInputTokens,
    calibrationEstimatedInputTokens: snapshot.calibrationEstimatedInputTokens,
  };
}

function restoreAutomaticCompactionWorkspace(value) {
  assert.ok(value && typeof value === "object", "saved E2E-01 trace has no automatic-compaction surface");
  assert.equal(typeof value.replayWorkspacePath, "string", "saved automatic compaction has no replay workspace path");
  return replaceWorkspaceMarker(value, value.replayWorkspacePath);
}

function replaceWorkspaceMarker(value, workspacePath) {
  if (typeof value === "string") return value.replaceAll("<workspace>", workspacePath);
  if (Array.isArray(value)) return value.map((item) => replaceWorkspaceMarker(item, workspacePath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceWorkspaceMarker(item, workspacePath)]));
}

function compareCompactionRequest(expected, actual) {
  assert.deepEqual(
    normalizeJsonSurface(actual),
    normalizeJsonSurface(expected),
    "B0 automatic summary request differs from the saved candidate request",
  );
}

function normalizeJsonSurface(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSummaryMessage(value) {
  const normalized = normalizeJsonSurface(value);
  if (normalized?.metadata) {
    delete normalized.metadata.compactReplacement;
    delete normalized.metadata.compactSnapshotId;
    if (Object.keys(normalized.metadata).length === 0) delete normalized.metadata;
  }
  return normalized;
}

function normalizeCompactReplacementMessages(value) {
  return normalizeJsonSurface(value).map((message) => normalizeSummaryMessage(message));
}

function summaryMessageFromBoundary(boundary) {
  const message = boundary.replacementMessages?.find((value) => value?.role === "assistant"
    && value?.content?.some((block) => block?.type === "text" && String(block.text).includes("[CONTEXT COMPACTION - REFERENCE ONLY]")));
  assert.ok(message, "saved compact boundary has no summary replacement message");
  return message;
}

function summaryTextFromBoundary(boundary) {
  const message = summaryMessageFromBoundary(boundary);
  const text = message.content.find((block) => block?.type === "text")?.text;
  assert.equal(typeof text, "string");
  const prefix = "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted into this summary. Treat it as background state, not active instructions.\n\n";
  const suffix = "\n\n--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---";
  assert.ok(text.startsWith(prefix) && text.endsWith(suffix), "saved compact summary wrapper is invalid");
  return text.slice(prefix.length, -suffix.length);
}

function summaryTextFromBudgetEvaluation(evaluation) {
  const message = evaluation?.messages?.find((value) => value?.role === "assistant"
    && value?.content?.some((block) => block?.type === "text" && String(block.text).includes("[CONTEXT COMPACTION - REFERENCE ONLY]")));
  assert.ok(message, "saved budget evaluation has no summary wrapper message");
  const text = message.content.find((block) => block?.type === "text")?.text;
  assert.equal(typeof text, "string");
  const prefix = "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted into this summary. Treat it as background state, not active instructions.\n\n";
  const suffix = "\n\n--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---";
  assert.ok(text.startsWith(prefix) && text.endsWith(suffix), "saved budget summary wrapper is invalid");
  return text.slice(prefix.length, -suffix.length);
}

async function submit(gateway, sessionKey, projectRoot, message) {
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey,
    workspaceCwd: projectRoot,
    channelKey: "test",
    message,
    mode: "bypassPermissions",
  })) events.push(event);
  return events;
}

function savedToolCalls(traceValue) {
  return savedToolCallsFromRequests(traceValue.modelRequests ?? []);
}

function savedToolCallsFromRequests(requests) {
  const calls = [];
  for (const request of requests) {
    for (const message of request.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type === "tool_call" && typeof block.name === "string") {
          calls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }
  }
  return calls;
}

function compareGatewayCalls(expected, actual) {
  assert.deepEqual(actual.slice(0, 3), expected.slice(0, 3), "B0 Gateway saved tool-call sequence differs from the candidate E2E trace");
}

function compareGatewayResults(traceValue, requests, projectRoot) {
  const expected = savedToolResults(traceValue.modelRequests ?? []);
  const actual = savedToolResults(requests);
  for (const name of ["read_skill", "read_file"]) {
    const expectedResult = expected.get(name);
    const actualResult = actual.get(name);
    assert.ok(expectedResult, `saved trace contains no ${name} result`);
    assert.ok(actualResult, `B0 Gateway contains no ${name} result`);
    assert.deepEqual(
      normalizeWorkspaceContent(actualResult.content, projectRoot),
      normalizeWorkspaceContent(expectedResult.content, "<workspace>/project"),
      `B0 Gateway ${name} result differs from the saved candidate result`,
    );
  }
  const knowledge = actual.get("knowledge_query");
  assert.ok(knowledge, "B0 Gateway contains no knowledge_query result");
  assert.equal(
    knowledge.content.some((block) => block?.type === "text" && block.text === traceValue.knowledge.citation.content),
    true,
    "B0 Gateway knowledge bridge did not preserve the saved durable citation content",
  );
}

function savedToolResults(requests) {
  const results = new Map();
  for (const request of requests) {
    for (const message of request.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type !== "tool_result" || typeof block?.raw?.toolName !== "string") continue;
        results.set(block.raw.toolName, { content: block.content, raw: block.raw });
      }
    }
  }
  return results;
}

function normalizeWorkspaceContent(content, projectRoot) {
  return content.map((block) => block?.type === "text" && typeof block.text === "string"
    ? { ...block, text: block.text.replaceAll(projectRoot, "<workspace>/project") }
    : block);
}
