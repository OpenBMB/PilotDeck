import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestBudgetEvidence } from "./budget_evidence.mjs";

const sourceRoot = process.env.PARITY_SOURCE_ROOT;
const sidecarRoot = process.env.PARITY_PILOTDECK_ROOT ?? sourceRoot;
const scenario = JSON.parse(process.env.PARITY_SCENARIO_JSON);
const mockBaseUrl = process.env.PARITY_MOCK_BASE_URL;
const traceOut = process.env.PARITY_TRACE_OUT;
const mode = process.env.PARITY_MODE;
const runKey = process.env.PARITY_RUN_KEY ?? `${mode}-parity`;
const invocationId = process.env.PARITY_INVOCATION_ID;
const keepRuntime = process.env.PARITY_KEEP_RUNTIME === "1";
const debug = (...values) => {
  if (process.env.PARITY_DEBUG === "1") console.error("[parity-gateway]", ...values);
};

if (!sourceRoot || !sidecarRoot || !mockBaseUrl || !traceOut || !invocationId) {
  throw new Error("PilotDeck gateway parity environment is incomplete.");
}

const importFrom = (root, relative) => import(pathToFileURL(path.join(root, relative)).href);
const { createLocalGateway } = await importFrom(sourceRoot, "dist/src/cli/createLocalGateway.js");
const { startPilotDeckServer } = await importFrom(sourceRoot, "dist/src/cli/pilotdeckServer.js");
const { GatewayWsClient } = await importFrom(sourceRoot, "dist/src/gateway/client/GatewayWsClient.js");
const { DEFAULT_MODEL_CAPABILITIES } = await importFrom(
  sourceRoot,
  "dist/src/model/protocol/capabilities.js",
);
const { TokenBudgetManager } = await importFrom(
  sourceRoot,
  "dist/src/context/budget/TokenBudgetManager.js",
);
const { getPilotProjectChatDir } = await importFrom(
  sourceRoot,
  "dist/src/pilot/paths.js",
);
const { sanitizeSessionIdForPath } = await importFrom(
  sourceRoot,
  "dist/src/session/storage/ProjectSessionStorage.js",
);
// The core branch has a narrow storage-provider seam. `origin/main` still
// owns the native JSONL storage directly, so a baseline run must not require
// this newer composition export merely to launch its Gateway.
const storageProviderEntrypoint = path.join(
  sourceRoot,
  "dist/src/session/storage/ProjectSessionStorageProvider.js",
);
let nodeProjectSessionStorageProvider;
let hasStorageProviderEntrypoint = false;
try {
  await access(storageProviderEntrypoint);
  hasStorageProviderEntrypoint = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (hasStorageProviderEntrypoint) {
  const module = await import(pathToFileURL(storageProviderEntrypoint).href);
  nodeProjectSessionStorageProvider = module.nodeProjectSessionStorageProvider;
}

let sequence = 0;
const trace = [];
const pendingBudgetRecords = [];
const pendingRequestRecords = [];
const parityTokenBudget = new TokenBudgetManager();
const linkRequestBudgetEvidence = () => {
  while (pendingBudgetRecords.length > 0 && pendingRequestRecords.length > 0) {
    const budgetRecord = pendingBudgetRecords.shift();
    const requestRecord = pendingRequestRecords.shift();
    budgetRecord.requestEvidence = createRequestBudgetEvidence({
      request: requestRecord.modelView,
      tokenBudget: parityTokenBudget,
      observedBudget: budgetRecord,
    });
  }
};
let modelAttempt = 0;
let scenarioTurnIndex = 0;
let scenarioTurnModelAttempt = 0;
const scopedModelAttempts = new Map();
const pendingCompactionIds = new Map();
let markModelStarted;
const modelStarted = new Promise((resolve) => {
  markModelStarted = resolve;
});
let markToolStarted;
const toolStarted = new Promise((resolve) => {
  markToolStarted = resolve;
});
const push = (kind, extra = {}) => {
  const record = { kind, scenarioId: scenario.scenarioId, q: scenario.q, invocationId, sequence: sequence++, ...extra };
  trace.push(record);
  if (kind === "context.budget") pendingBudgetRecords.push(record);
  if (kind === "model.request") {
    // AgentLoop emits the prepared context budget immediately before the
    // provider-visible request. Retain only the next request candidate so a
    // budget cannot be linked to the preceding completed request.
    pendingRequestRecords.splice(0, pendingRequestRecords.length, record);
    linkRequestBudgetEvidence();
  }
};
const modelView = (request) => ({
  provider: request.provider,
  model: request.model,
  maxOutputTokens: request.maxOutputTokens,
  systemPrompt: request.systemPrompt,
  messages: request.messages,
  tools: request.tools,
  cachePlan: request.cachePlan,
  cacheBreakpoints: request.cacheBreakpoints,
  thinking: request.thinking,
  toolChoice: request.toolChoice,
  speed: request.speed,
  metadata: request.metadata,
});
const faultAt = (target, attempt, stage) => (scenario.faults?.[target] ?? []).find(
  (fault) => (fault.at ?? 1) === attempt && (!stage || !fault.stage || fault.stage === stage),
);
const post = async (pathname, body, signal) => {
  const response = await fetch(`${mockBaseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return response.json();
};

async function waitForSubagentModelRequest({ timeoutMs = 5000 } = {}) {
  return waitForSubagentModelRequests({ timeoutMs, count: 1 });
}

async function waitForSubagentModelRequests({ timeoutMs = 5000, count }) {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    const state = await post("/control/state", { runKey });
    latest = Number(state.subagentModelRequests ?? 0);
    if (latest >= count) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} subagent model request(s); observed ${latest}.`);
}

async function waitForScopedModelResponses({ timeoutMs = 5000, agentScope, count }) {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    latest = trace.filter((record) =>
      record.kind === "model.response" && record.agentScope === agentScope).length;
    if (latest >= count) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} ${agentScope} model response(s); observed ${latest}.`);
}

class MockModelRuntime {
  async *stream(request, options = {}) {
    modelAttempt += 1;
    scenarioTurnModelAttempt += 1;
    const invocationAttempt = modelAttempt;
    const agentScope = isSubagentModelRequest(request) ? "child" : "parent";
    const attempt = (scopedModelAttempts.get(agentScope) ?? 0) + 1;
    scopedModelAttempts.set(agentScope, attempt);
    const afterCompactionId = pendingCompactionIds.get(agentScope);
    if (afterCompactionId) pendingCompactionIds.delete(agentScope);
    push("model.request", {
      agentScope,
      attempt,
      ...(afterCompactionId ? { afterCompactionId } : {}),
      modelView: modelView(request),
      request,
    });
    markModelStarted();
    const fault = faultAt("model", invocationAttempt);
    if (fault?.action === "retryable_error" || fault?.action === "non_retryable_error") {
      const retryable = fault.action === "retryable_error";
      const error = Object.assign(new Error(retryable ? "Deterministic temporary provider failure." : "Deterministic permanent provider failure."), {
        code: retryable ? "provider_unavailable" : "invalid_model_response",
        retryable,
      });
      push("fault.injected", { agentScope, target: "model", action: fault.action, attempt });
      push("model.error", { agentScope, code: error.code, message: error.message, retryable, attempt });
      throw error;
    }
    if (fault?.action === "stream_interruption") {
      push("fault.injected", { agentScope, target: "model", action: fault.action, attempt });
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "partial" };
      throw Object.assign(new Error("Deterministic stream interruption."), { code: "stream_interrupted", retryable: false });
    }
    const responsePromise = post("/v1/chat/completions", {
      scenarioId: scenario.scenarioId,
      q: scenario.q,
      messages: request.messages,
      tools: request.tools,
      // A child AgentLoop inherits this metadata through the native subagent
      // composition. The deterministic provider uses it only to select its
      // fixture response; the sidecar never receives or owns child state.
      isSubagent: isSubagentModelRequest(request),
      delays: scenario.delays,
      toolDelays: scenario.toolDelays,
      // Model faults are injected above using the shared invocation sequence.
      // Do not forward them to the backend: its request counter excludes a
      // locally injected attempt and would fault a later parent request again.
      faults: { ...(scenario.faults ?? {}), model: [] },
      turnIndex: scenarioTurnIndex,
      turnModelAttempt: scenarioTurnModelAttempt,
      runKey,
    }, options.signal);
    if (scenario.scenarioId === "sidecar_live_model_stream") {
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      push("model.stream", { agentScope, state: "first_delta" });
      yield { type: "text_delta", text: "STREAM_PREFIX::" };
      const response = await responsePromise;
      push("model.stream", { agentScope, state: "provider_completed" });
      const message = response.choices[0].message;
      push("model.response", { agentScope, attempt, modelView: message, response: message });
      yield { type: "text_delta", text: message.content ?? "" };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    const response = await responsePromise;
    if (fault?.action === "malformed_response") {
      push("fault.injected", { agentScope, target: "model", action: fault.action, attempt });
      throw Object.assign(new Error("Deterministic malformed model response."), { code: "invalid_model_response", retryable: false });
    }
    const message = response.choices[0].message;
    push("model.response", { agentScope, attempt, modelView: message, response: message });
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    for (const call of message.tool_calls ?? []) {
      yield {
        type: "tool_call_end",
        toolCall: {
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        },
      };
    }
    if (scenario.scenarioId === "sidecar_budget_limit") {
      yield { type: "usage", usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, nativeCost: 1 } };
    }
    if (message.tool_calls?.length) {
      yield { type: "message_end", finishReason: "tool_call" };
    } else {
      yield { type: "text_delta", text: message.content ?? "" };
      yield { type: "message_end", finishReason: "stop" };
    }
  }

  async complete() {
    return { role: "assistant", content: [{ type: "text", text: "Parity session" }], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true };
  }

  getMultimodal() {
    return { input: ["text", "image"] };
  }

  getProviderProtocol() {
    return "openai";
  }

  getProviderBaseUrl() {
    return mockBaseUrl;
  }
}

function isSubagentModelRequest(request) {
  if (typeof request.metadata?.subagentId === "string") return true;
  return (request.messages ?? []).some((message) =>
    (message.content ?? []).some((block) =>
      block?.type === "text"
      && (block.text === "Return one deterministic subagent report."
        || block.text === "Return one deterministic one-shot subagent report.")
    )
  );
}

function createTools() {
  return (scenario.tools ?? []).filter((name) =>
    !["ask_user_question", "read_file", "write_file", "enter_plan_mode", "exit_plan_mode"].includes(name),
  ).map((name) => ({
    name,
    description: scenario.toolDescription ?? name,
    kind: "custom",
    inputSchema: { type: "object" },
    isReadOnly: () => !["restricted", "loop", "parity_write_probe"].includes(name),
    isConcurrencySafe: () => ["lookup", "summarize"].includes(name),
    requiresUserInteraction: () => name === "ask_user_question",
    checkPermissions: async (_input, context) => {
      push("policy.context", { toolName: name, permissionMode: context.permissionMode, runMode: context.runMode });
      push("permission.request", { toolName: name, mode: context.permissionMode, canPrompt: scenario.permission?.canPrompt ?? false });
      const deniedByRule = scenario.permission?.deny?.includes(name) ?? false;
      const deniedByAnswer = scenario.permission?.ask?.includes(name) && scenario.permission?.answer === "deny";
      const denied = deniedByRule || deniedByAnswer;
      if (scenario.permission?.ask?.includes(name)) {
        push("permission.answer", { toolName: name, allowed: !denied, code: denied ? "PERMISSION_DENIED" : undefined });
      }
      push("permission.decision", { toolName: name, allowed: !denied });
      return denied
        ? {
            type: "deny",
            message: "Deterministic permission denial.",
            reason: { type: "tool", toolName: name, message: "denied" },
          }
        : {
            type: "allow",
            reason: { type: "tool", toolName: name, message: "allowed" },
          };
    },
    execute: async (input, context) => {
      const concurrencySafe = ["lookup", "summarize"].includes(name);
      const toolCallId = context.currentToolCallId;
      push("tool.call", { name, arguments: input, toolCallId, concurrencySafe, sideEffectCount: 0 });
      push("tool.start", { name, toolCallId, concurrencySafe, sideEffectCount: 0 });
      markToolStarted();
      if (name === "progress_tool") {
        context.progress?.({
          toolCallId,
          toolName: name,
          message: "deterministic progress",
          metadata: { source: "parity" },
          createdAt: new Date().toISOString(),
        });
      }
      const forwardCancellation = () => {
        void post("/control/cancel", { runKey }).catch(() => undefined);
      };
      context.abortSignal?.addEventListener("abort", forwardCancellation, { once: true });
      const result = await post("/tools/execute", {
        scenarioId: scenario.scenarioId,
        q: scenario.q,
        name,
        arguments: input,
        permissionAllowed: true,
        delays: scenario.delays,
        toolDelays: scenario.toolDelays,
        faults: scenario.faults,
        runKey,
      }, context.abortSignal).finally(() => {
        context.abortSignal?.removeEventListener("abort", forwardCancellation);
      });
      push("tool.finish", { name, toolCallId, concurrencySafe, success: result.type === "success", error: result.error, sideEffectCount: result.data?.sideEffectCount ?? 0 });
      push("tool.result", { result: { ...result, toolCallId }, toolCallId, concurrencySafe, sideEffectCount: result.data?.sideEffectCount ?? 0 });
      if (result.type === "error") {
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }
      return { content: [{ type: "text", text: JSON.stringify(result.data) }], data: result.data };
    },
  }));
}

function createParityReadFileTool() {
  return {
    name: "read_file",
    description: "Reads a deterministic parity file.",
    kind: "filesystem",
    inputSchema: { type: "object", required: ["file_path"], properties: { file_path: { type: "string" } } },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: async (input, context) => {
      const allowed = (context.allowedReadFiles ?? []).some((file) => String(file).endsWith(String(input.file_path ?? "")));
      push("permission.decision", { toolName: "read_file", allowed });
      return allowed ? { type: "allow", reason: { type: "tool", toolName: "read_file" } } : { type: "deny", message: "File is not in allowedReadFiles." };
    },
    execute: async (input) => ({ content: [{ type: "text", text: "deterministic file content" }], data: { path: input.file_path, content: "deterministic file content" } }),
  };
}

function createParityCompactionProvider() {
  let compacted = false;
  return {
    async autoCompact(input) {
      if (scenario.historyTurns?.length && !input.messages.some((message) =>
        message.content?.some((block) => block.type === "text" && block.text === scenario.q))) {
        return {
          type: "skipped",
          snapshot: { tokens: 20, maxContextTokens: input.maxContextTokens ?? 1_024, warningRatio: 0.8, blockingRatio: 0.9, state: "ok", ratio: 0.02 },
        };
      }
      if (compacted) {
        return {
          type: "skipped",
          snapshot: {
            tokens: 20,
            maxContextTokens: input.maxContextTokens ?? 1_024,
            warningRatio: 0.8,
            blockingRatio: 0.9,
            state: "ok",
            ratio: 0.02,
          },
        };
      }
      if (["sidecar_full_request_compaction_budget", "sidecar_projected_request_compaction_budget"].includes(scenario.scenarioId)) {
        if (!input.budgetEvaluator) throw new Error("Full-request compaction scenario requires a request budget evaluator.");
        const budget = await input.budgetEvaluator(input.messages);
        push("compaction.budget", {
          phase: "source",
          tokens: budget.tokens,
          systemTokens: budget.breakdown?.system ?? 0,
          toolTokens: budget.breakdown?.tools ?? 0,
          messageTokens: budget.breakdown?.messages ?? 0,
        });
      }
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "durable compact summary" }] },
        { role: "user", content: [{ type: "text", text: scenario.q }] },
      ];
      let snapshot = {
        tokens: 20,
        maxContextTokens: input.maxContextTokens ?? 1_024,
        warningRatio: 0.8,
        blockingRatio: 0.9,
        state: "ok",
        ratio: 0.02,
      };
      if (["sidecar_full_request_compaction_budget", "sidecar_projected_request_compaction_budget"].includes(scenario.scenarioId)) {
        const budget = await input.budgetEvaluator(messages);
        snapshot = budget;
        push("compaction.budget", {
          phase: "replacement",
          tokens: budget.tokens,
          systemTokens: budget.breakdown?.system ?? 0,
          toolTokens: budget.breakdown?.tools ?? 0,
          messageTokens: budget.breakdown?.messages ?? 0,
        });
      }
      compacted = true;
      return {
        type: "compacted",
        tier: "full",
        messages,
        snapshot,
        result: {
          compactionId: "parity-durable-compaction",
          trigger: "auto",
          preTokens: 800,
          postTokens: 20,
          messagesSummarized: 1,
          boundaryMarker: { role: "assistant", content: [{ type: "text", text: "durable compact boundary" }] },
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        },
      };
    },
    buildPostCompactMessages: () => [],
    truncateHeadPreservingCheckpoint: (messages) => messages,
  };
}

function createObservedPersistenceProvider() {
  if (!nodeProjectSessionStorageProvider) return undefined;
  return {
    ...nodeProjectSessionStorageProvider,
    create(input) {
      const backends = nodeProjectSessionStorageProvider.create(input);
      const agentScope = input.kind === "subagent" ? "child" : "parent";
      return {
        ...backends,
        persistence: {
          append: async (entry) => {
            await backends.persistence.append(entry);
            if (entry.type === "agent_status_message") {
              push("durable.status", { agentScope, event: entry.event, statusKind: entry.kind, text: entry.text });
            }
            if (entry.type === "durable_message" && entry.message?.metadata?.queueItemId) {
              push("durable.steer", { agentScope, itemId: entry.message.metadata.queueItemId, message: entry.message });
            }
            if (entry.type === "control_boundary" && entry.boundary?.subtype === "compact_boundary") {
              const compactionId = entry.boundary.compactMetadata?.compactionId;
              if (compactionId) pendingCompactionIds.set(agentScope, compactionId);
              push("compact.boundary", {
                agentScope,
                compactionId,
                messages: entry.boundary.replacementMessages,
                metadata: entry.boundary.compactMetadata,
              });
            }
            if (entry.type === "compaction_completed" && entry.status !== "skipped") {
              push("durable.compaction_completed", {
                agentScope,
                operationId: entry.operationId,
                compactionId: entry.compactionId,
                status: entry.status,
              });
            }
          },
          load: () => backends.persistence.load(),
          flush: () => backends.persistence.flush(),
        },
      };
    },
  };
}

async function readTranscriptEntries(sessionKey) {
  const transcriptPath = path.join(
    getPilotProjectChatDir(projectRoot, pilotHome),
    `${sanitizeSessionIdForPath(sessionKey)}.jsonl`,
  );
  const contents = await readFile(transcriptPath, "utf8");
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readSettledTranscript(sessionKey, turnId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (true) {
    try {
      entries = await readTranscriptEntries(sessionKey);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const result = [...entries].reverse().find((entry) =>
      entry.type === "turn_result" && entry.turnId === turnId
    )?.result;
    if (result || Date.now() >= deadline) return { entries, result };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const configuredRuntimeRoot = process.env.PARITY_RUNTIME_ROOT;
const runtimeRoot = configuredRuntimeRoot
  ? path.resolve(configuredRuntimeRoot)
  : await mkdtemp(path.join(tmpdir(), `pilotdeck-full-${mode}-`));
await mkdir(runtimeRoot, { recursive: true });
const pilotHome = path.join(runtimeRoot, "home");
await mkdir(pilotHome, { recursive: true });
process.env.PILOT_HOME = pilotHome;
const projectRoot = pilotHome;
const configuredContextTokens = scenario.limits?.maxContextTokens ?? 65536;
const configuredOutputTokens = scenario.limits?.maxOutputTokens ?? 8192;
const configuredMaxContextMessages = scenario.limits?.maxContextMessages;
let subagentIdSequence = 0;
const nextSubagentId = () => {
  subagentIdSequence += 1;
  return `00000000-0000-4000-8000-${String(subagentIdSequence).padStart(12, "0")}`;
};
await writeFile(path.join(pilotHome, "pilotdeck.yaml"), `schemaVersion: 1\nagent:\n  model: parity/deterministic\n  maxContextTokens: ${configuredContextTokens}\n  maxOutputTokens: ${configuredOutputTokens}${configuredMaxContextMessages ? `\n  maxContextMessages: ${configuredMaxContextMessages}` : ""}\nmodel:\n  providers:\n    parity:\n      protocol: openai\n      url: ${mockBaseUrl}\n      apiKey: parity-test\n      models:\n        deterministic:\n          capabilities:\n            supportsToolUse: true\n            maxContextTokens: ${configuredContextTokens}\n            maxOutputTokens: ${configuredOutputTokens}\ntelemetry:\n  enabled: false\n`, "utf8");
await writeFile(path.join(projectRoot, "parity-input.txt"), "deterministic file content\n", "utf8");
if (["plan_mode_host_policy", "plan_mode_bypass_host_policy"].includes(scenario.scenarioId)) {
  await mkdir(path.join(projectRoot, ".pilotdeck", "plans"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".pilotdeck", "plans", "parity-plan.md"),
    "# Parity plan\n\nExecute the deterministic plan.\n",
    "utf8",
  );
}
const gatewayEnv = {
  ...process.env,
  ...(mode === "sidecar" ? {
    PILOTDECK_AGENT_LOOP_TRANSPORT: "stdio",
    PILOTDECK_AGENT_LOOP_SIDECAR_COMMAND: process.execPath,
    PILOTDECK_AGENT_LOOP_SIDECAR_PATH: path.join(sidecarRoot, "dist/src/cli/pilotdeck-agent-loop-sidecar.js"),
  } : {
    PILOTDECK_AGENT_LOOP_TRANSPORT: "native",
  }),
};
push("harness.proof", { state: "transport_selected", transport: mode === "sidecar" ? "stdio" : "native" });

const observedPersistenceProvider = createObservedPersistenceProvider();
const local = createLocalGateway({
  projectRoot,
  pilotHome,
  env: gatewayEnv,
  permissionMode: scenario.permission?.mode ?? "default",
  extraTools: [
    ...createTools(),
  ],
  __testModelFactory: () => new MockModelRuntime(),
  __testSubagentIdFactory: nextSubagentId,
  ...(Number.isInteger(configuredMaxContextMessages) && configuredMaxContextMessages > 0
    ? { __testAgentConfigOverrides: { maxContextMessages: configuredMaxContextMessages } }
    : {}),
  autoElicitation: scenario.permission?.answer === "allow" || scenario.interaction?.elicitationAvailable === true,
  ...(observedPersistenceProvider ? { storageProvider: observedPersistenceProvider } : {}),
  ...(["sidecar_durable_compaction", "sidecar_full_request_compaction_budget", "sidecar_projected_request_compaction_budget"].includes(scenario.scenarioId)
    ? { compactionProviderFactory: () => createParityCompactionProvider() }
    : {}),
  ...(mode === "sidecar" ? {
    agentLoopTransportObserver: {
      observe(observation) {
        push("harness.proof", { state: observation.type, ...observation });
      },
    },
  } : {}),
});
const server = await startPilotDeckServer({
  gateway: local.gateway,
  host: "127.0.0.1",
  port: 0,
  staticAssetsPath: path.join(sourceRoot, "ui", "dist"),
});
local.bindServer(server);

if (process.env.PARITY_SERVE_ONLY === "1") {
  console.log(JSON.stringify({ url: server.url, wsUrl: server.wsUrl, token: server.token }));
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  await local.dispose();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true });
  process.exit(0);
}

const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
const controlClient = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test-control" });
try {
  await client.connect();
  await controlClient.connect();
  // Each adapter owns and fully disposes its isolated runtime, so use the same
  // model-visible session identity on both sides.
  const sessionKey = `full-${scenario.scenarioId}`;
  const runId = `run-${scenario.scenarioId}`;
  let seedReadResult;
  for (const message of scenario.historyTurns ?? []) {
    for await (const _event of client.stream("submit_turn", {
      sessionKey,
      channelKey: "test",
      message,
      mode: "default",
      canPrompt: false,
    })) {
      // Build durable history through the production Gateway path.
    }
  }
  const resumePrelude = scenario.scenarioId === "checkpoint_resume"
    ? { message: "Previous deterministic result", mode: "default" }
    : scenario.scenarioId === "write_snapshot_resume"
      ? { message: "Persist the parity write snapshot", mode: "bypassPermissions" }
      : undefined;
  if (resumePrelude) {
    for await (const _event of client.stream("submit_turn", {
      sessionKey,
      channelKey: "test",
      message: resumePrelude.message,
      mode: resumePrelude.mode,
      canPrompt: false,
    })) {
      // Populate real durable history before forcing session reconstruction.
    }
    await controlClient.request("close_session", {
      sessionKey,
      reason: "parity_resume_rebuild",
    });
    push("session.lifecycle", { state: "closed_for_resume", reason: "parity_resume_rebuild" });
  }
  if (scenario.scenarioId === "sidecar_seed_read_state") {
    const observedMtime = Math.floor((await stat(path.join(projectRoot, "parity-input.txt"))).mtimeMs);
    seedReadResult = await client.request("seed_read_state", {
      sessionKey,
      channelKey: "test",
      workspaceCwd: projectRoot,
      path: "parity-input.txt",
      mtime: observedMtime,
    });
  }
  const attachments = [];
  if ((scenario.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((item) => item.type === "image_url"))) {
    const block = scenario.messages?.at(-1)?.content?.find((item) => item.type === "image_url");
    const match = /^data:([^;]+);base64,(.+)$/.exec(block?.image_url?.url ?? "");
    if (!match) throw new Error("Image scenario is missing a data URL.");
    const imagePath = path.join(projectRoot, "parity-image.png");
    await writeFile(imagePath, Buffer.from(match[2], "base64"));
    attachments.push({ type: "image", name: "parity-image.png", path: imagePath, mimeType: match[1] });
  }
  const limits = scenario.limits ?? {};
  if (Array.isArray(scenario.turns) && scenario.turns.length > 0) {
    let visibleOutput = "";
    let terminal;
    let terminalErrorCode;
    let observedPermissionMode = scenario.permission?.mode ?? "default";
    const builtinToolLifecycleNames = new Set(["enter_plan_mode", "exit_plan_mode", "todo_write"]);

    for (const [turnIndex, turn] of scenario.turns.entries()) {
      scenarioTurnIndex = turnIndex;
      scenarioTurnModelAttempt = 0;
      push("policy.turn", { permissionMode: observedPermissionMode, runMode: observedPermissionMode === "plan" ? "plan" : "agent" });

      const stream = client.stream("submit_turn", {
        sessionKey,
        channelKey: "test",
        message: typeof turn.message === "string" ? turn.message : scenario.q,
        attachments: turnIndex === 0 ? attachments : [],
        canPrompt: scenario.permission?.canPrompt ?? false,
        canElicit: scenario.permission?.canElicit ?? false,
        ...((scenario.systemPrompt !== undefined || scenario.sdkSessionConfig)
          ? { sdkSessionConfig: { ...(scenario.sdkSessionConfig ?? {}), ...(scenario.systemPrompt !== undefined ? { systemPrompt: scenario.systemPrompt } : {}) } }
          : {}),
        ...(turn.allowPlanModeTools ? { allowPlanModeTools: true } : {}),
        ...(turn.omitClientMode ? {} : { mode: scenario.permission?.mode ?? "default" }),
      });

      for await (const event of stream) {
        if (event.type === "tool_call_started" && builtinToolLifecycleNames.has(event.name)) {
          push("tool.call", { name: event.name, toolCallId: event.toolCallId });
          push("tool.start", { name: event.name, toolCallId: event.toolCallId });
        }
        if (event.type === "tool_call_finished" && builtinToolLifecycleNames.has(event.toolName)) {
          push("tool.finish", {
            name: event.toolName,
            toolCallId: event.toolCallId,
            success: event.ok,
            error: event.errorCode ? { code: event.errorCode, message: event.resultPreview } : undefined,
          });
          push("tool.result", {
            toolCallId: event.toolCallId,
            result: event.ok
              ? { type: "success", data: { preview: event.resultPreview } }
              : { type: "error", error: { code: event.errorCode, message: event.resultPreview } },
          });
        }
        if (event.type === "tool_call_finished" && event.errorCode === "plan_mode_violation") {
          push("tool.finish", {
            name: event.toolName,
            toolCallId: event.toolCallId,
            success: false,
            error: { code: event.errorCode, message: event.resultPreview },
          });
          push("tool.result", {
            toolCallId: event.toolCallId,
            result: { type: "error", error: { code: event.errorCode, message: event.resultPreview } },
          });
        }
        if (event.type === "elicitation_request" && event.toolName === "exit_plan_mode") {
          const question = event.questions[0]?.question;
          if (typeof question !== "string") {
            throw new Error("exit_plan_mode elicitation did not include a question.");
          }
          const response = await client.request("elicitation_respond", {
            sessionKey,
            requestId: event.requestId,
            answer: { type: "answered", answers: { [question]: "execute_plan" } },
          });
          if (!response || response.delivered !== true) {
            throw new Error("Deterministic exit_plan_mode approval was not delivered.");
          }
        }
        if (event.type === "assistant_text_delta") {
          visibleOutput += event.text;
          push("user.output", { text: event.text });
        }
        if (event.type === "plan_mode_changed") observedPermissionMode = event.mode;
        if (event.type === "turn_completed") terminal = event;
        if (event.type === "error") {
          terminalErrorCode = event.code;
          push("gateway.error", { code: event.code, message: event.message });
        }
      }
    }

    const mockState = await post("/control/state", { runKey });
    const sideEffectCounts = mockState.sideEffects ?? {};
    push("side_effect.state", {
      counts: sideEffectCounts,
      sideEffectCount: Object.values(sideEffectCounts).reduce((total, value) => total + Number(value || 0), 0),
    });
    const finishReason = terminal?.finishReason ?? "unknown";
    push("terminal", {
      outcome: finishReason === "completed" ? "completed" : finishReason.includes("abort") ? "cancelled" : "failed",
      code: terminalErrorCode ?? (finishReason === "max_turns" ? "agent_max_turns_reached" : undefined),
      stopReason: finishReason,
      output: visibleOutput,
      usage: terminal?.usage,
      resultType: terminal?.result?.type,
    });
    await writeFile(traceOut, `${trace.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  } else {
  const stream = client.stream("submit_turn", {
    sessionKey,
    channelKey: "test",
    message: scenario.q,
    attachments,
    mode: scenario.permission?.mode ?? "default",
    canPrompt: scenario.permission?.canPrompt ?? false,
    canElicit: scenario.permission?.canElicit ?? false,
    ...((scenario.systemPrompt !== undefined || scenario.sdkSessionConfig)
      ? { sdkSessionConfig: { ...(scenario.sdkSessionConfig ?? {}), ...(scenario.systemPrompt !== undefined ? { systemPrompt: scenario.systemPrompt } : {}) } }
      : {}),
    runId,
    maxTurns: limits.maxTurns,
    maxBudgetUsd: limits.maxBudgetUsd,
    timeoutMs: limits.deadlineMs,
  });
  const cancelAfterMs = limits.cancelAfterToolStartMs ?? limits.cancelAfterMs;
  const cancelAnchor = limits.cancelAfterToolStartMs ? toolStarted : modelStarted;
  const cancelTask = cancelAfterMs
    ? cancelAnchor.then(() => new Promise((resolve) => setTimeout(resolve, cancelAfterMs))).then(async () => {
        push("cancel.requested", { sessionKey });
        await post("/control/cancel", { runKey });
        return controlClient.request("abort_turn", { sessionKey, reason: "parity_cancel" }).then(
          () => push("cancel.acknowledged", { sessionKey }),
          (error) => push("cancel.error", { message: error?.message ?? String(error) }),
        );
      })
    : undefined;
  const steerTask = scenario.steer?.message
    ? modelStarted.then(async () => {
        const result = await controlClient.request("steer_turn", {
          sessionKey,
          runId,
          itemId: scenario.steer.itemId ?? "parity-steer-1",
          message: scenario.steer.message,
        });
        push("steer.request", { itemId: scenario.steer.itemId ?? "parity-steer-1", accepted: result.accepted });
        return result;
      })
    : undefined;
  const closeAfterChildModel = scenario.lifecycle?.closeSessionAfterSubagentModel === true;
  const closeTask = closeAfterChildModel
    ? waitForSubagentModelRequest({ timeoutMs: Number(scenario.limits?.closeWaitMs) || 5000 }).then(async (subagentModelRequests) => {
        push("sidecar.lifecycle", {
          state: "parent_close_requested",
          stage: "child_model_started",
          subagentModelRequests,
        });
        await local.gateway.closeSession({ sessionKey, reason: "parity_parent_close" });
        push("sidecar.lifecycle", {
          state: "parent_closed",
          stage: "child_first_drain",
          parentClosed: true,
          subagentModelRequests,
        });
      })
    : undefined;
  const abortAfterChildModel = scenario.lifecycle?.abortTurnAfterSubagentModel === true;
  const abortTask = abortAfterChildModel
    ? waitForSubagentModelRequest({ timeoutMs: Number(scenario.limits?.abortWaitMs) || 5000 }).then(async (subagentModelRequests) => {
        push("sidecar.lifecycle", {
          state: "parent_abort_requested",
          stage: "child_model_started",
          subagentModelRequests,
        });
        await post("/control/cancel", { runKey });
        await controlClient.request("abort_turn", { sessionKey, reason: "parity_parent_abort_after_child_admission" });
        push("sidecar.lifecycle", {
          state: "parent_abort_acknowledged",
          stage: "child_model_started",
          parentAborted: true,
          subagentModelRequests,
        });
      })
    : undefined;
  let visibleOutput = "";
  let terminal;
  let terminalCount = 0;
  let terminalErrorCode;
  const builtinToolLifecycleNames = new Set(["agent", "ask_user_question", "read_file", "write_file", "subagent", "send_message"]);
  for await (const event of stream) {
    // These built-ins emit lifecycle only through the Gateway stream. Keep
    // their port-level effects in the same trace vocabulary as parity tools.
    if (event.type === "tool_call_started" && builtinToolLifecycleNames.has(event.name)) {
      push("tool.call", {
        name: event.name,
        toolCallId: event.toolCallId,
        ...(event.name === "read_file" && event.argsPreview
          ? { arguments: { preview: event.argsPreview } }
          : {}),
      });
      push("tool.start", { name: event.name, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_call_finished" && builtinToolLifecycleNames.has(event.toolName)) {
      if (event.toolName === "read_file") {
        const denied = event.errorCode === "permission_denied" || event.errorCode === "permission_required";
        push("permission.decision", { toolName: event.toolName, allowed: event.ok && !denied });
      }
      push("tool.finish", {
        name: event.toolName,
        toolCallId: event.toolCallId,
        success: event.ok,
        error: event.errorCode ? { code: event.errorCode, message: event.resultPreview } : undefined,
      });
      push("tool.result", {
        toolCallId: event.toolCallId,
        result: event.ok
          ? { type: "success", data: { preview: event.resultPreview } }
          : { type: "error", error: { code: event.errorCode, message: event.resultPreview } },
      });
    }
    if (event.type === "permission_request") {
      push("permission.request", { requestId: event.requestId, toolName: event.toolName, payload: event.payload });
    }
    if (event.type === "steer_applied") {
      push("steer.applied", { itemId: event.itemId, message: event.message });
    }
    if (event.type === "agent_status") {
      push("agent.status", { event: event.event, detail: event.detail });
    }
    if (event.type === "context_budget") {
      push("context.budget", {
        used: event.used,
        displayUsed: event.displayUsed,
        budgetUsed: event.budgetUsed,
        total: event.total,
        effectiveTotal: event.effectiveTotal,
        reservedOutputTokens: event.reservedOutputTokens,
        ratio: event.ratio,
        state: event.state,
        source: event.source,
        exact: event.exact,
        breakdown: event.breakdown,
      });
    }
    if (event.type === "tool_progress") {
      push("tool.progress", { toolCallId: event.toolCallId, toolName: event.toolName, message: event.message, metadata: event.metadata });
    }
    if (event.type === "assistant_text_delta") {
      visibleOutput += event.text;
      push("user.output", { text: event.text });
    }
    if (event.type === "turn_completed") {
      terminal = event;
      terminalCount += 1;
    }
    if (event.type === "error") {
      terminalErrorCode = event.code;
      push("gateway.error", { code: event.code, message: event.message });
    }
  }
  if (cancelTask) await cancelTask;
  if (steerTask) await steerTask;
  if (closeTask) await closeTask;
  if (abortTask) {
    await abortTask;
    push("sidecar.lifecycle", {
      state: "parent_abort_settled",
      stage: "turn_terminal",
      parentAborted: true,
      terminalCount,
    });
  }
  if (scenario.scenarioId === "sidecar_seed_read_state") {
    push("seed.state", {
      applied: seedReadResult?.applied === true,
      fileContent: await readFile(path.join(projectRoot, "parity-input.txt"), "utf8"),
    });
  }
  if (["sidecar_continuable_followup_live", "sidecar_continuable_followup_cold"].includes(scenario.scenarioId)) {
    const timeoutMs = Number(scenario.limits?.subagentWaitMs) || 5000;
    const observedChildRequests = await waitForSubagentModelRequests({
      timeoutMs,
      count: 2,
    }).catch(async () => Number((await post("/control/state", { runKey })).subagentModelRequests ?? 0));
    push("sidecar.lifecycle", {
      state: "continuable_followup_observed",
      stage: "turn_terminal",
      subagentModelRequests: observedChildRequests,
    });
    if (observedChildRequests >= 2) {
      await waitForScopedModelResponses({ timeoutMs, agentScope: "child", count: 2 });
      if (scenario.scenarioId === "sidecar_continuable_followup_live") {
        await waitForScopedModelResponses({ timeoutMs, agentScope: "parent", count: 4 });
      }
    }
  }
  const mockState = await post("/control/state", { runKey });
  const sideEffectCounts = mockState.sideEffects ?? {};
  push("side_effect.state", {
    counts: sideEffectCounts,
    sideEffectCount: Object.values(sideEffectCounts).reduce((total, value) => total + Number(value || 0), 0),
  });
  const { entries: transcriptEntries, result: durableTurnResult } = await readSettledTranscript(sessionKey, runId);
  const operationTerminal = [...transcriptEntries].reverse().find((entry) =>
    entry.type === "agent_loop_operation_terminal" && entry.turnId === runId
  );
  if (operationTerminal) {
    push("operation.terminal", {
      outcome: operationTerminal.outcome,
      code: operationTerminal.code,
      lastAppliedSequence: operationTerminal.lastAppliedSequence,
    });
  }
  const durableStatusCount = transcriptEntries.filter((entry) =>
    entry.type === "agent_status_message" && entry.event === "max_budget_reached"
  ).length;
  const durableSteerCount = transcriptEntries.filter((entry) =>
    entry.type === "durable_message" && entry.message?.metadata?.queueItemId === (scenario.steer?.itemId ?? "parity-steer-1")
  ).length;
  const compactionBoundaryCount = transcriptEntries.filter((entry) =>
    entry.type === "control_boundary" && entry.boundary?.subtype === "compact_boundary"
  ).length;
  // A completed `skipped` bracket records a budget decision, not a durable
  // replacement. Counting it as compaction made main/current comparisons
  // report a fake behavioral drift whenever the newer context wrapper was
  // present.
  const compactionCompletedCount = transcriptEntries.filter((entry) =>
    entry.type === "compaction_completed" && entry.status !== "skipped"
  ).length;
  let replayedStatusCount;
  if (scenario.verifyStatusReplay === true) {
    const replayClient = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test-replay" });
    await replayClient.connect();
    try {
      const history = await replayClient.request("read_session_messages", { sessionKey });
      replayedStatusCount = (history.messages ?? []).filter((message) =>
        message.payload?.event === "max_budget_reached"
      ).length;
    } finally {
      replayClient.close();
    }
  }
  push("durable.state", {
    durableStatusCount,
    durableSteerCount,
    compactionBoundaryCount,
    compactionCompletedCount,
    ...(replayedStatusCount === undefined ? {} : { replayedStatusCount }),
  });
  debug("gateway stream closed", terminal?.finishReason ?? "without terminal");
  const finishReason = terminal?.finishReason ?? "unknown";
  push("terminal", {
    outcome: finishReason === "completed" ? "completed" : finishReason.includes("abort") ? "cancelled" : "failed",
    code: terminalErrorCode ?? (finishReason === "max_turns" ? "agent_max_turns_reached" : undefined),
    stopReason: finishReason,
    output: visibleOutput,
    usage: terminal?.usage,
    resultType: durableTurnResult?.type,
    durableStopReason: durableTurnResult?.stopReason,
    durableErrorCode: durableTurnResult?.errors?.[0]?.code,
  });
  await writeFile(traceOut, `${trace.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
} finally {
  debug("closing deployment");
  client.close();
  controlClient.close();
  await server.close();
  await local.dispose();
  if (!keepRuntime) await rm(runtimeRoot, { recursive: true, force: true });
}
