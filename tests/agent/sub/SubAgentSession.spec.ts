import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { CanonicalMessage } from "../../../src/model/index.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import { createNativeOneShotSubagentPort } from "../../../src/agent/sub/OneShotSubagentPort.js";
import type {
  ResolvedSubagentRunRequest,
  SubagentProvider,
} from "../../../src/agent/sub/SubagentProvider.js";
import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "../../../src/agent/sub/builtinSubagentTypes.js";
import {
  snapshotSubagentDescriptor,
} from "../../../src/agent/sub/SubagentDescriptor.js";
import {
  recordSubagentAcceptedInputWithDescriptor,
  SUBAGENT_DESCRIPTOR_METADATA_KEY,
} from "../../../src/agent/sub/SubagentDescriptorPersistence.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
} from "../../../src/permission/index.js";
import { createBashTool } from "../../../src/tool/builtin/bash.js";
import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import { createExecuteCodeTool } from "../../../src/tool/builtin/executeCode.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import {
  ToolRegistry,
  createAgentTool,
  createSubagentContinuationTool,
  type PilotDeckSubagentForkApi,
  type PilotDeckToolDefinition,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { loadPilotConfig } from "../../../src/pilot/index.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const tempPilotHomes: string[] = [];

afterEach(() => {
  for (const dir of tempPilotHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type TestableSubAgentSession = {
  buildInitialMessages(): CanonicalMessage[];
  buildScopedRegistry(): ToolRegistry;
  buildConfig(): AgentRuntimeConfig;
  createScopedRuntime(): {
    dependencies: AgentRuntimeDependencies;
    dispose(): Promise<void>;
  };
};

function createNoopTool(
  name: string,
  isReadOnly: PilotDeckToolDefinition["isReadOnly"],
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      data: {},
    }),
  };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

function createBlockingRouter(onStarted?: () => void): AgentRouterRuntime {
  return {
    ...createRouter(),
    execute: async function* (_decision, _request, context) {
      onStarted?.();
      await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal;
        if (!signal) {
          reject(new Error("blocking test router requires an abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  } as AgentRouterRuntime;
}

function parentConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createSubagentForkHarness(
  router: AgentRouterRuntime,
  config = parentConfig(),
): {
  events: AgentEvent[];
  fork: PilotDeckSubagentForkApi;
} {
  const events: AgentEvent[] = [];
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {} as never,
    },
    eventEmitter: (event) => {
      events.push(event);
    },
  };
  const fork = createNativeOneShotSubagentPort({
    config,
    dependencies,
  }).createForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
  });
  return { events, fork };
}

function sessionFor(
  definition: SubagentDefinition,
  registry: ToolRegistry,
  config = parentConfig(),
): TestableSubAgentSession {
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: config,
    parentDependencies: {
      router: {} as AgentRuntimeDependencies["router"],
      tools: {
        registry,
        scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"],
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
  };
  return new SubAgentSession(options) as unknown as TestableSubAgentSession;
}

test("subagent depth capability exposes delegation only to an eligible general-purpose child", () => {
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  registry.register(createSubagentContinuationTool({
    start: async () => ({ childSessionId: "nested", itemId: "item", turnId: "turn" }),
    followup: async () => ({ childSessionId: "nested", itemId: "item", turnId: "turn" }),
  }));

  const defaultDepth = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);
  assert.equal(defaultDepth.buildScopedRegistry().has("agent"), false);
  assert.equal(defaultDepth.buildScopedRegistry().has("subagent"), false);

  const nestedDepth = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry, {
    ...parentConfig(),
    maxSubagentDepth: 2,
  });
  assert.equal(nestedDepth.buildScopedRegistry().has("agent"), true);
  assert.equal(nestedDepth.buildScopedRegistry().has("subagent"), true);

  const readOnlyNestedDepth = sessionFor(SUBAGENT_DEFINITIONS.explore, registry, {
    ...parentConfig(),
    maxSubagentDepth: 2,
  });
  assert.equal(readOnlyNestedDepth.buildScopedRegistry().has("agent"), false);
  assert.equal(readOnlyNestedDepth.buildScopedRegistry().has("subagent"), false);
});

test("subagent composition preserves a third-party agent definition and its execute closure", async () => {
  let calls = 0;
  const customAgent: PilotDeckToolDefinition = {
    name: "agent",
    description: "third-party delegation sentinel",
    kind: "agent",
    requiredRuntimeCapabilities: ["subagent_fork"],
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async () => {
      calls += 1;
      return { content: [{ type: "text", text: "custom-agent-sentinel" }], data: { source: "custom" } };
    },
  };
  const registry = new ToolRegistry();
  registry.register(customAgent);

  const blocked = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);
  assert.equal(blocked.buildScopedRegistry().has("agent"), false);

  const nested = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry, {
    ...parentConfig(),
    maxSubagentDepth: 2,
  }).buildScopedRegistry();
  const inherited = nested.get("agent");
  assert.equal(inherited, customAgent);
  const result = await inherited!.execute({}, {} as never);
  assert.deepEqual(result.data, { source: "custom" });
  assert.equal(calls, 1);
  assert.equal(nested.has("subagent"), false);
});

test("SubAgentSession delegates to the named subagent provider", async () => {
  const definition = SUBAGENT_DEFINITIONS.explore;
  let received: ResolvedSubagentRunRequest | undefined;
  const provider: SubagentProvider = {
    name: "test-provider",
    capabilities: { continuation: false, depthLimit: true, toolFilter: true },
    run: async (request) => {
      received = request;
      return {
        subagentId: request.subagentId,
        definitionId: request.definition.id,
        markdown: FINAL_REPORT,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 3,
      };
    },
  };
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: {} as AgentRuntimeDependencies["router"],
      tools: {
        registry: new ToolRegistry(),
        scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"],
      },
      subagentProvider: provider,
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
  };

  const report = await new SubAgentSession(options).run();

  assert.equal(received?.directive, options.directive);
  assert.equal(received?.parentSessionId, options.parentSessionId);
  assert.equal(received?.subagentId, options.subagentId);
  assert.deepEqual(received?.descriptor, {
    version: 1,
    mode: "one-shot",
    provider: "test-provider",
    definitionId: "explore",
  });
  assert.equal(report.markdown, FINAL_REPORT);
});

test("native subagent hands its resolved descriptor to sidechain persistence before running", async () => {
  let acceptedMetadata: Record<string, unknown> | undefined;
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: createRouter(),
      tools: { registry: new ToolRegistry(), scheduler: {} as never },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
    sidechainTranscript: {
      recordAcceptedInput: async (_sessionId, _turnId, _messages, metadata) => {
        acceptedMetadata = metadata;
      },
      recordDurableMessage: async () => undefined,
    },
  });
  const descriptor = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "selected-provider",
    definitionId: "explore",
  });

  await session.runNative(descriptor);

  assert.deepEqual(acceptedMetadata?.[SUBAGENT_DESCRIPTOR_METADATA_KEY], descriptor);
});

test("native one-shot subagent completes its durable child turn without releasing caller-owned sidechain storage", async () => {
  const transcript = new InMemoryTranscriptWriter();
  let sidechainDisposals = 0;
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: createRouter(),
      tools: { registry: new ToolRegistry(), scheduler: {} as never },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
    sidechainTranscript: {
      recordSessionEvent: transcript.recordSessionEvent.bind(transcript),
      recordAcceptedInput: (sessionId, turnId, messages, metadata) =>
        recordSubagentAcceptedInputWithDescriptor(transcript, sessionId, turnId, messages, metadata),
      recordDurableMessage: transcript.recordDurableMessage.bind(transcript),
      recordTurnResult: transcript.recordTurnResult.bind(transcript),
      dispose: async () => {
        sidechainDisposals += 1;
      },
    },
  });
  const descriptor = snapshotSubagentDescriptor({
    mode: "one-shot",
    provider: "pilotdeck-native",
    definitionId: "explore",
  });

  await session.runNative(descriptor);

  assert.deepEqual(
    transcript.entries.map((entry) => entry.type),
    [
      "turn_started",
      "subagent_descriptor",
      "accepted_input",
      "step_started",
      "model_request",
      "model_stream_event",
      "model_stream_event",
      "durable_message",
      "step_completed",
      "turn_result",
    ],
  );
  assert.equal(transcript.entries.every((entry) => entry.sessionId === "child-session"), true);
  assert.equal(transcript.entries.every((entry) => entry.turnId === "child-agent-t0"), true);
  assert.equal(sidechainDisposals, 0);
});

function runtimeContext(config: AgentRuntimeConfig): PilotDeckToolRuntimeContext {
  return {
    sessionId: "child-session",
    turnId: "child-turn",
    cwd: config.cwd,
    runMode: config.runMode,
    permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  };
}

function writePilotConfig(raw: string): string {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-subagent-config-"));
  tempPilotHomes.push(pilotHome);
  writeFileSync(join(pilotHome, "pilotdeck.yaml"), raw, "utf8");
  return pilotHome;
}

function loadInlinePilotConfig(raw: string) {
  const pilotHome = writePilotConfig(raw);
  return loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
}

function pilotConfigWithSubagentDefault(defaultValue: string): string {
  return `
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    default: ${defaultValue}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`;
}

test("agent.subagents.default inherit keeps subagent model unset", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("inherit"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.default"), false);
});

test("agent.subagents.maxDepth is parsed as the opt-in nested delegation cap", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    maxDepth: 2
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal(snapshot.config.agent.subagents?.maxDepth, 2);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.maxDepth"), false);
});

test("agent.subagents.maxDepth accepts zero to disable delegation", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    maxDepth: 0
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal(snapshot.config.agent.subagents?.maxDepth, 0);
});

test("agent.subagents.params is reported as unsupported instead of being silently discarded", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    params:
      maxOutputTokens: 4096
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal("params" in (snapshot.config.agent.subagents ?? {}), false);
  assert.deepEqual(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.params"),
    {
      code: "CONFIG_AGENT_SUBAGENTS_PARAMS_UNSUPPORTED",
      severity: "warning",
      message: "agent.subagents.params is not supported and will be ignored.",
      path: "agent.subagents.params",
      recoverable: true,
    },
  );
});

test("empty agent.subagents.params does not create a warning", () => {
  const snapshot = loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    params: {}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
`);

  assert.equal(
    snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agent.subagents.params"),
    false,
  );
});

test("agent.subagents.default resolves a configured model", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/child-model"));

  assert.deepEqual(snapshot.config.agent.subagents?.default, {
    id: "child/child-model",
    provider: "child",
    model: "child-model",
  });
});

test("agent.subagents.default inherits with a warning when provider is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing/child-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.deepEqual(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default"),
    {
      code: "CONFIG_AGENT_SUBAGENT_PROVIDER_NOT_FOUND",
      severity: "warning",
      message: "agent.subagents.default references unknown provider missing. Inheriting agent.model instead.",
      path: "agent.subagents.default",
      recoverable: true,
    },
  );
});

test("agent.subagents.default inherits with a warning when model is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/missing-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_NOT_FOUND",
  );
});

test("agent.subagents.default inherits with a warning when malformed", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing-format"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find((diagnostic) => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_INVALID",
  );
});

test("agent.model still fails fast when provider is missing", () => {
  assert.throws(
    () => loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: missing/main-model
  subagents:
    default: child/child-model
model:
  providers:
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`),
    (error) =>
      error instanceof PilotConfigError &&
      error.diagnostics.some((diagnostic) => diagnostic.code === "CONFIG_AGENT_PROVIDER_NOT_FOUND"),
  );
});

test("explore subagent does not probe tool safety before execution", async () => {
  const readOnlyChecks: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createNoopTool("execute_code", (input) => {
    readOnlyChecks.push("execute_code");
    return (input as { code: string }).code.length === 0;
  }));
  registry.register(createNoopTool("read_file", () => {
    readOnlyChecks.push("read_file");
    return true;
  }));

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the provided files.",
    parentConfig: {
      provider: "test",
      model: "test-model",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: process.cwd(),
        mode: "bypassPermissions",
        canPrompt: true,
        bypassAvailable: true,
      }),
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown, FINAL_REPORT);
  assert.deepEqual(readOnlyChecks, []);
});

test("custom SDK subagent definitions scope tools, mode, and turn budget", () => {
  const registry = new ToolRegistry();
  registry.register(createNoopTool("read_file", () => true));
  registry.register(createNoopTool("bash", () => false));
  const definition: SubagentDefinition = {
    id: "reviewer",
    description: "Review source files.",
    allowedTools: ["*"],
    disallowedTools: ["bash"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: true,
    systemPromptSuffix: "Review only.",
    maxTurns: 2,
    permissionMode: "plan",
  };
  const session = sessionFor(definition, registry);
  const scoped = session.buildScopedRegistry();
  assert.equal(scoped.has("read_file"), true);
  assert.equal(scoped.has("bash"), false);
  const config = session.buildConfig();
  assert.equal(config.permissionMode, "plan");
  assert.equal(config.permissionContext.mode, "plan");
});

test("dynamic subagent initial prompt and critical reminder stay scoped to its fork", () => {
  const registry = new ToolRegistry();
  const session = sessionFor({
    ...SUBAGENT_DEFINITIONS["general-purpose"],
    initialPrompt: "First, inspect the repository conventions.",
    criticalSystemReminder: "Return only verified findings.",
  }, registry);

  const messages = session.buildInitialMessages();
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "First, inspect the repository conventions." }] },
    { role: "user", content: [{ type: "text", text: "Inspect the workspace." }] },
  ]);
  assert.match(session.buildConfig().systemPrompt ?? "", /Return only verified findings\./);

  const defaultSession = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);
  assert.deepEqual(defaultSession.buildInitialMessages(), [
    { role: "user", content: [{ type: "text", text: "Inspect the workspace." }] },
  ]);
  assert.doesNotMatch(defaultSession.buildConfig().systemPrompt ?? "", /Return only verified findings\./);
});

test("parent abort emits an aborted subagent completion event", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { events, fork } = createSubagentForkHarness(
    createBlockingRouter(() => markStarted?.()),
  );
  const controller = new AbortController();

  const running = fork.fork({
    definitionId: "explore",
    directive: "Wait until the parent stops.",
    subagentId: "subagent-aborted",
    abortSignal: controller.signal,
    timeoutMs: 60_000,
  });
  await started;
  controller.abort("parent stopped");
  await assert.rejects(running, /subagent turn aborted/);

  const completed = events.find((event) => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, true);
});

test("subagent timeout remains a failure instead of a cancellation", async () => {
  const { events, fork } = createSubagentForkHarness(createBlockingRouter());

  await assert.rejects(fork.fork({
    definitionId: "explore",
    directive: "Wait until timeout.",
    subagentId: "subagent-timeout",
    timeoutMs: 5,
  }), /Subagent timed out after 5ms/);

  const completed = events.find((event) => event.type === "subagent_completed");
  assert.ok(completed && completed.type === "subagent_completed");
  assert.equal(completed.success, false);
  assert.equal(completed.aborted, false);
});

test("explore registry ignores an unallowed dynamic execute_code tool without probing it", () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  registry.register(createBashTool({
    runner: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
    },
  }));

  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();

  assert.deepEqual(scoped.list().map((tool) => tool.name), ["bash"]);
  assert.equal(session.buildConfig().runMode, "ask");
});

test("subagent child scope inherits parent services and disposes independently", async () => {
  const registry = new ToolRegistry();
  const router = createRouter();
  const permission = new PermissionRuntime();
  const context = {} as NonNullable<AgentRuntimeDependencies["context"]>;
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect the provided files.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router,
      permission,
      context,
      tools: { registry, scheduler: {} as never },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-scoped",
  }) as unknown as TestableSubAgentSession;

  const scoped = session.createScopedRuntime();
  assert.equal(scoped.dependencies.router, router);
  assert.equal(scoped.dependencies.permission, permission);
  assert.equal(scoped.dependencies.context, context);
  assert.notEqual(scoped.dependencies.tools.registry, registry);
  assert.equal(scoped.dependencies.scope?.state, "active");

  registry.register(createNoopTool("late_parent_tool", () => true));
  assert.equal(scoped.dependencies.tools.registry.has("late_parent_tool"), true);

  await scoped.dispose();
  assert.equal(scoped.dependencies.scope?.state, "disposed");
});

test("subagent config uses configured default model without copying caps to top-level overrides", () => {
  const registry = new ToolRegistry();
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect the provided files.",
    parentConfig: {
      ...parentConfig(),
      provider: "main",
      model: "main-model",
      modelMultimodal: { input: ["text"] },
      maxContextTokens: 100000,
      maxOutputTokens: 20000,
      subagentModel: {
        provider: "child",
        model: "child-model",
        modelMultimodal: { input: ["text", "image"] },
        maxContextTokens: 32000,
        maxOutputTokens: 4096,
      },
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  }) as unknown as TestableSubAgentSession;

  const config = session.buildConfig();

  assert.equal(config.provider, "child");
  assert.equal(config.model, "child-model");
  assert.deepEqual(config.modelMultimodal, { input: ["text", "image"] });
  assert.equal(config.maxContextTokens, undefined);
  assert.equal(config.maxOutputTokens, undefined);
  assert.deepEqual(config.subagentModel, {
    provider: "child",
    model: "child-model",
    modelMultimodal: { input: ["text", "image"] },
    maxContextTokens: 32000,
    maxOutputTokens: 4096,
  });
  assert.equal(config.isSubagent, true);
});

test("definition model overrides the native subagent default without changing its inheritance state", () => {
  const registry = new ToolRegistry();
  const session = new SubAgentSession({
    definition: {
      ...SUBAGENT_DEFINITIONS["general-purpose"],
      modelOverride: { provider: "review", model: "review-model" },
    },
    directive: "Review the change.",
    parentConfig: {
      ...parentConfig(),
      provider: "main",
      model: "main-model",
      maxContextTokens: 100000,
      maxOutputTokens: 20000,
      subagentModel: { provider: "default", model: "default-model" },
    },
    parentDependencies: {
      router: createRouter(),
      tools: { registry, scheduler: {} as never },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-override",
  }) as unknown as TestableSubAgentSession;

  const config = session.buildConfig();

  assert.equal(config.provider, "review");
  assert.equal(config.model, "review-model");
  assert.equal(config.maxContextTokens, undefined);
  assert.equal(config.maxOutputTokens, undefined);
  assert.deepEqual(config.subagentModel, { provider: "default", model: "default-model" });
});

test("subagent config inherits parent model when no default is configured", () => {
  const registry = new ToolRegistry();
  const session = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);

  const config = session.buildConfig();

  assert.equal(config.provider, "test");
  assert.equal(config.model, "test-model");
  assert.equal(config.isSubagent, true);
});

test("configured subagent default remains a router baseline, not a router override", async () => {
  const seen: Array<{ stage: "decide" | "execute"; provider: string; model: string; isMainAgent?: boolean }> = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request, isMainAgent }) => {
      seen.push({
        stage: "decide",
        provider: request.provider,
        model: request.model,
        isMainAgent,
      });
      return {
        provider: "routed",
        model: "tier-model",
        scenarioType: "default",
        isSubagent: true,
        orchestrating: false,
        resolvedFrom: "tokenSaver",
        mutations: {},
      };
    },
    execute: async function* (_decision, request) {
      seen.push({
        stage: "execute",
        provider: request.provider,
        model: request.model,
      });
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
  const { events, fork } = createSubagentForkHarness(router, {
    ...parentConfig(),
    provider: "main",
    model: "main-model",
    subagentModel: {
      provider: "child",
      model: "child-model",
    },
  });

  await fork.fork({
    definitionId: "explore",
    directive: "Inspect routing.",
    subagentId: "subagent-routed",
    timeoutMs: 60_000,
  });

  assert.deepEqual(seen, [
    {
      stage: "decide",
      provider: "child",
      model: "child-model",
      isMainAgent: false,
    },
    {
      stage: "execute",
      provider: "routed",
      model: "tier-model",
    },
  ]);
  assert.ok(events.some((event) => event.type === "subagent_completed"));
});

test("read-only subagent evaluates bash safety from the real command", async () => {
  const commands: string[] = [];
  const runner: PilotDeckCommandRunner = {
    async run(command) {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: `${command}\n`,
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  const readResult = await runtime.execute(
    { id: "read-command", name: "bash", input: { command: "pwd" } },
    runtimeContext(config),
  );
  assert.equal(readResult.type, "success");
  assert.deepEqual(commands, ["pwd"]);

  const writeResult = await runtime.execute(
    { id: "write-command", name: "bash", input: { command: "touch blocked.txt" } },
    runtimeContext(config),
  );
  assert.equal(writeResult.type, "error");
  assert.equal(writeResult.type === "error" ? writeResult.error.code : "", "ask_mode_violation");
  assert.deepEqual(commands, ["pwd"], "blocked command must not reach the shell runner");
});

test("read-only execute_code checks the real code instead of crashing on registry setup", async () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  const definition: SubagentDefinition = {
    ...SUBAGENT_DEFINITIONS.explore,
    allowedTools: ["execute_code"],
  };
  const session = sessionFor(definition, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  assert.equal(scoped.has("execute_code"), true);
  const result = await runtime.execute(
    {
      id: "write-code",
      name: "execute_code",
      input: {
        code: "from pilotdeck_tools import write_file\nwrite_file('blocked.txt', 'no')",
      },
    },
    runtimeContext(config),
  );
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : "", "ask_mode_violation");
});
