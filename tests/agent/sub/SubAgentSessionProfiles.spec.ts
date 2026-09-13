import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import {
  AgentLoop,
  type AgentLoopInput,
} from "../../../src/agent/loop/AgentLoop.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import {
  resolveSubagentProfiles,
  type ResolvedSubagentProfile,
} from "../../../src/agent/sub/subagentProfiles.js";
import type { SubagentModel } from "../../../src/agent/sub/subagentModels.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
} from "../../../src/permission/index.js";
import {
  ToolRegistry,
  type PilotDeckSubagentForkApi,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

type TestableSubAgentSession = {
  buildScopedRegistry(): ToolRegistry;
  buildConfig(): AgentRuntimeConfig;
};

type TestableAgentLoop = {
  buildSubagentForkApi(
    input: AgentLoopInput,
    messages: CanonicalMessage[],
  ): PilotDeckSubagentForkApi;
};

const visionModel: SubagentModel = {
  id: "gateway/vendor/vision",
  provider: "gateway",
  model: "vendor/vision",
  description: "Visual review",
  modelMultimodal: { input: ["text", "image"] as ("text" | "image")[] },
  maxContextTokens: 16000,
  maxOutputTokens: 4000,
};

function createNoopTool(name: string): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    isReadOnly: () => name === "read_file",
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], data: {} }),
  };
}

function parentConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
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
    ...overrides,
  };
}

function sessionFor(
  definition: ResolvedSubagentProfile,
  registry: ToolRegistry,
  configOverrides: Partial<AgentRuntimeConfig> = {},
): TestableSubAgentSession {
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(configOverrides),
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
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

function forkHarness(configOverrides: Partial<AgentRuntimeConfig>): PilotDeckSubagentForkApi {
  const loop = new AgentLoop(parentConfig(configOverrides), {
    router: createRouter(),
    tools: {
      registry: new ToolRegistry(),
      scheduler: {} as never,
    },
  }) as unknown as TestableAgentLoop;
  return loop.buildSubagentForkApi({
    sessionId: "parent-session",
    turnId: "parent-turn",
    messages: [],
  }, []);
}

test("fork rejects nesting at runtime even without tool schema help", async () => {
  const atCap = forkHarness({ subagentDepth: 1, maxSubagentDepth: 1 });
  await assert.rejects(
    atCap.fork({
      definitionId: "explore",
      directive: "Should never run.",
      subagentId: "subagent-nested",
      timeoutMs: 60_000,
    }),
    /subagent_depth_exceeded/,
  );

  const zeroDepth = forkHarness({ subagentDepth: 0, maxSubagentDepth: 0 });
  await assert.rejects(
    zeroDepth.fork({
      definitionId: "explore",
      directive: "Should never run.",
      subagentId: "subagent-top",
      timeoutMs: 60_000,
    }),
    /subagent_depth_exceeded/,
  );
});

test("disabled and ask-mode-incompatible profiles are not dispatchable", () => {
  const profiles = resolveSubagentProfiles({
    vision: { description: "Vision reviewer.", readOnly: true },
    writer: { description: "Writable writer.", readOnly: false },
    explore: { description: "Off.", enabled: false },
  });
  const normal = forkHarness({ subagentProfiles: profiles });
  assert.equal(normal.isAllowedDefinition("vision"), true);
  assert.equal(normal.isAllowedDefinition("writer"), true);
  assert.equal(normal.isAllowedDefinition("explore"), false);
  assert.deepEqual(
    normal.listDefinitions().map((definition) => definition.id).sort(),
    ["general-purpose", "plan", "verify", "vision", "writer"],
  );

  const ask = forkHarness({
    subagentProfiles: profiles,
    runMode: "ask",
  });
  assert.equal(ask.isAllowedDefinition("vision"), true);
  assert.equal(ask.isAllowedDefinition("writer"), false);
  assert.equal(ask.isAllowedDefinition("general-purpose"), false);
  assert.deepEqual(
    ask.listDefinitions().map((definition) => definition.id).sort(),
    ["plan", "verify", "vision"],
  );
});

test("child registry gains the agent tool only below the depth cap and when allowed", () => {
  const registry = new ToolRegistry();
  registry.register(createNoopTool("agent"));
  registry.register(createNoopTool("read_file"));
  registry.register(createNoopTool("write_file"));

  const belowCap = sessionFor(
    resolveSubagentProfiles().find((profile) => profile.id === "general-purpose")!,
    registry,
    { subagentDepth: 1, maxSubagentDepth: 2 },
  );
  assert.ok(belowCap.buildScopedRegistry().has("agent"));

  const atCap = sessionFor(
    resolveSubagentProfiles().find((profile) => profile.id === "general-purpose")!,
    registry,
    { subagentDepth: 1, maxSubagentDepth: 1 },
  );
  assert.equal(atCap.buildScopedRegistry().has("agent"), false);

  const notAllowed = sessionFor(
    resolveSubagentProfiles().find((profile) => profile.id === "explore")!,
    registry,
    { subagentDepth: 1, maxSubagentDepth: 2 },
  );
  assert.equal(notAllowed.buildScopedRegistry().has("agent"), false);

  const explicitAgent = sessionFor(
    resolveSubagentProfiles({
      sentinel: { description: "Sentinel.", tools: ["read_file", "agent"] },
    }).find((profile) => profile.id === "sentinel")!,
    registry,
    { subagentDepth: 1, maxSubagentDepth: 2 },
  );
  const scoped = explicitAgent.buildScopedRegistry();
  assert.deepEqual(scoped.list().map((tool) => tool.name).sort(), ["agent", "read_file"]);
});

test("custom read-only profiles intersect the parent registry and enforce ask mode", () => {
  const registry = new ToolRegistry();
  registry.register(createNoopTool("read_file"));
  registry.register(createNoopTool("write_file"));
  registry.register(createNoopTool("bash"));

  const profiles = resolveSubagentProfiles({
    auditor: { description: "Auditor.", tools: ["read_file", "bash"] },
  });
  const session = sessionFor(profiles.find((profile) => profile.id === "auditor")!, registry);
  const scoped = session.buildScopedRegistry();
  assert.deepEqual(scoped.list().map((tool) => tool.name).sort(), ["bash", "read_file"]);
  assert.equal(session.buildConfig().runMode, "ask");
});

test("ancestor ask mode persists for writable custom profiles", () => {
  const registry = new ToolRegistry();
  const profiles = resolveSubagentProfiles({
    writer: { description: "Writable writer.", readOnly: false },
  });
  const session = sessionFor(profiles.find((profile) => profile.id === "writer")!, registry, {
    runMode: "ask",
  });
  assert.equal(session.buildConfig().runMode, "ask");

  const planSession = sessionFor(
    profiles.find((profile) => profile.id === "writer")!,
    registry,
    { permissionMode: "plan" },
  );
  assert.equal(planSession.buildConfig().runMode, "ask");
});

test("profile-bound model drives the child config with its own caps", () => {
  const registry = new ToolRegistry();
  const profiles = resolveSubagentProfiles({
    vision: { description: "Vision reviewer.", model: "gateway/vendor/vision" },
  });
  const options: SubAgentSessionOptions = {
    model: visionModel,
    definition: profiles.find((profile) => profile.id === "vision")!,
    directive: "Inspect the image.",
    parentConfig: parentConfig({
      maxContextTokens: 100000,
      maxOutputTokens: 20000,
      subagentModel: { provider: "default", model: "child-model" },
    }),
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
  };
  const config = (new SubAgentSession(options) as unknown as TestableSubAgentSession).buildConfig();
  assert.equal(config.provider, "gateway");
  assert.equal(config.model, "vendor/vision");
  assert.deepEqual(config.modelMultimodal, visionModel.modelMultimodal);
  assert.equal(config.maxContextTokens, visionModel.maxContextTokens);
  assert.equal(config.maxOutputTokens, visionModel.maxOutputTokens);
  assert.equal(config.subagentModel, undefined);
  assert.equal(config.isSubagent, true);
});

test("subagent profiles survive into the child runtime config for nested dispatch", () => {
  const registry = new ToolRegistry();
  const profiles = resolveSubagentProfiles({
    vision: { description: "Vision reviewer." },
  });
  const session = sessionFor(
    profiles.find((profile) => profile.id === "vision")!,
    registry,
    { subagentProfiles: profiles, maxSubagentDepth: 2 },
  );
  const config = session.buildConfig();
  assert.deepEqual(
    config.subagentProfiles?.map((profile) => profile.id),
    profiles.map((profile) => profile.id),
  );
  assert.equal(config.maxSubagentDepth, 2);
});
