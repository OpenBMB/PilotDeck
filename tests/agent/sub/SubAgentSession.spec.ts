import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import {
  SUBAGENT_DEFINITIONS,
  type SubagentDefinition,
} from "../../../src/agent/sub/builtinSubagentTypes.js";
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
  type PilotDeckToolDefinition,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

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

function sessionFor(
  definition: SubagentDefinition,
  registry: ToolRegistry,
): TestableSubAgentSession {
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
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
