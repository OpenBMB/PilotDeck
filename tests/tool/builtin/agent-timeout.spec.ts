import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAskModeAgentToolSchema,
  createAgentTool,
} from "../../../src/tool/builtin/agent.js";
import type { AgentToolInput } from "../../../src/tool/builtin/agent.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

type ForkArgs = Parameters<PilotDeckSubagentForkApi["fork"]>[0];

function baseContext(
  fork: PilotDeckSubagentForkApi | undefined,
  overrides: Partial<PilotDeckToolRuntimeContext> = {},
): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    subagent: fork,
    ...overrides,
  };
}

function createFork(args: ForkArgs[]): PilotDeckSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [
      { id: "general-purpose", description: "general" },
      { id: "explore", description: "explore" },
      { id: "plan", description: "plan" },
      { id: "verify", description: "verify" },
    ],
    isAllowedDefinition: (id) =>
      ["general-purpose", "explore", "plan", "verify"].includes(id),
    fork: async (forkArgs) => {
      args.push(forkArgs);
      return {
        markdown:
          "Scope: test\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        parsed: undefined,
      };
    },
  };
}

function inputWithTimeout(timeoutMs: unknown): AgentToolInput {
  return { description: "d", prompt: "p", timeout_ms: timeoutMs } as unknown as AgentToolInput;
}

test("explicit timeout_ms overrides context.subagentTimeoutMs", async () => {
  const forkArgs: ForkArgs[] = [];
  const tool = createAgentTool();
  await tool.execute(
    inputWithTimeout(5_000),
    baseContext(createFork(forkArgs), { subagentTimeoutMs: 600_000 }),
  );
  assert.equal(forkArgs.length, 1);
  assert.equal(forkArgs[0]?.timeoutMs, 5_000);
});

test("explicit longer timeout_ms still takes precedence over configured timeout", async () => {
  const forkArgs: ForkArgs[] = [];
  const tool = createAgentTool();
  await tool.execute(
    inputWithTimeout(3_600_000),
    baseContext(createFork(forkArgs), { subagentTimeoutMs: 60_000 }),
  );
  assert.equal(forkArgs[0]?.timeoutMs, 3_600_000);
});

test("omitted timeout_ms keeps context.subagentTimeoutMs", async () => {
  const forkArgs: ForkArgs[] = [];
  const tool = createAgentTool();
  await tool.execute(
    { description: "d", prompt: "p" },
    baseContext(createFork(forkArgs), { subagentTimeoutMs: 90_000 }),
  );
  assert.equal(forkArgs[0]?.timeoutMs, 90_000);
});

test("omitted timeout_ms without configured value falls back to the 1 hour default", async () => {
  const forkArgs: ForkArgs[] = [];
  const tool = createAgentTool();
  await tool.execute({ description: "d", prompt: "p" }, baseContext(createFork(forkArgs)));
  assert.equal(forkArgs[0]?.timeoutMs, 60 * 60_000);
});

test("boundary timeout_ms values are accepted (1 and 2147483647)", async () => {
  for (const value of [1, 2_147_483_647]) {
    const forkArgs: ForkArgs[] = [];
    const tool = createAgentTool();
    await tool.execute(inputWithTimeout(value), baseContext(createFork(forkArgs)));
    assert.equal(forkArgs[0]?.timeoutMs, value);
  }
});

test("invalid timeout_ms values are rejected as invalid_tool_input before fork", async () => {
  const invalid = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    2_147_483_648,
    null,
    "5000",
    true,
  ];
  for (const value of invalid) {
    const forkArgs: ForkArgs[] = [];
    const tool = createAgentTool();
    await assert.rejects(
      tool.execute(inputWithTimeout(value), baseContext(createFork(forkArgs))),
      (error: unknown) =>
        error instanceof PilotDeckToolRuntimeError &&
        error.code === "invalid_tool_input" &&
        /timeout_ms/.test(error.message),
    );
    assert.equal(forkArgs.length, 0, `fork must not run for ${String(value)}`);
  }
});

test("legacy fallback path rejects explicit timeout_ms as unsupported_tool before model work", async () => {
  let streams = 0;
  const model: PilotDeckToolModelClient = {
    async *stream() {
      streams += 1;
      yield { type: "text_delta", text: "nope" };
    },
  };
  const tool = createAgentTool({ model });
  await assert.rejects(
    tool.execute(inputWithTimeout(1_000), baseContext(undefined)),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError && error.code === "unsupported_tool",
  );
  assert.equal(streams, 0);
});

test("legacy fallback path without timeout_ms is unchanged", async () => {
  let streams = 0;
  const model: PilotDeckToolModelClient = {
    async *stream() {
      streams += 1;
      yield { type: "text_delta", text: "legacy ok" };
    },
  };
  const tool = createAgentTool({ model });
  const result = await tool.execute({ description: "d", prompt: "p" }, baseContext(undefined));
  assert.equal(streams, 1);
  assert.match(result.data?.text ?? "", /legacy ok/);
});

test("timeout_ms is exposed as an optional integer property in both schemas", () => {
  const maxMs = 2_147_483_647;
  for (const schema of [
    createAgentTool().inputSchema,
    buildAskModeAgentToolSchema().inputSchema,
  ]) {
    const properties = schema.properties as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const timeout = properties.timeout_ms;
    assert.ok(timeout, "timeout_ms property missing");
    assert.equal(timeout.type, "integer");
    assert.equal(timeout.minimum, 1);
    assert.equal(timeout.maximum, maxMs);
    assert.match(String(timeout.description), /millisecond/i);
    assert.deepEqual(schema.required, ["description", "prompt"]);
  }
});
