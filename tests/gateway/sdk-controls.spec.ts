import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "../../src/agent/index.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function fakeSession(id: string): AgentSession {
  return {
    abort() {},
    snapshot() {
      return { sessionId: id, messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
  } as unknown as AgentSession;
}

test("Gateway host turn limits reject invalid caps", () => {
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession("turn-limit"),
  });
  try {
    assert.throws(
      () => new InProcessGateway(router, { turnLimits: { maxTurns: 0 } }),
      { code: "INVALID_GATEWAY_TURN_LIMIT" },
    );
    assert.throws(
      () => new InProcessGateway(router, { turnLimits: { maxBudgetUsd: Number.NaN } }),
      { code: "INVALID_GATEWAY_TURN_LIMIT" },
    );
  } finally {
    router.shutdown();
  }
});

test("tool filters persist across unfiltered turns and recreate only for explicit changes", async () => {
  let creates = 0;
  const recreatedContexts: Array<{ allowedTools?: string[]; disallowedTools?: string[] }> = [];
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(`session-${++creates}`),
    recreateSession: (context) => {
      recreatedContexts.push({
        allowedTools: context.allowedTools,
        disallowedTools: context.disallowedTools,
      });
      return fakeSession(`session-${++creates}`);
    },
  });

  await router.getOrCreate({ sessionKey: "sdk:tool-filter", channelKey: "api_server", allowedTools: [] });
  await router.getOrCreate({ sessionKey: "sdk:tool-filter", channelKey: "api_server" });
  assert.equal(creates, 1, "an omitted filter retains the explicit empty allow-list");

  await router.getOrCreate({
    sessionKey: "sdk:tool-filter",
    channelKey: "api_server",
    allowedTools: ["read_file"],
  });
  assert.equal(creates, 2, "an explicit filter change rebuilds the native session");
  assert.deepEqual(recreatedContexts, [{ allowedTools: ["read_file"], disallowedTools: undefined }]);

  await router.getOrCreate({ sessionKey: "sdk:tool-filter", channelKey: "api_server" });
  assert.equal(creates, 2, "a later unfiltered turn must not restore the native default tool set");
  router.shutdown();
});

test("SDK thinking control validates input and evicts the cached session", async () => {
  let creates = 0;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(`session-${++creates}`),
  });
  await router.getOrCreate({ sessionKey: "sdk:s1", channelKey: "api_server" });

  let received: unknown;
  const gateway = new InProcessGateway(router, {
    setSessionThinking: async (input) => {
      received = input;
      return { applied: true };
    },
  });
  assert.deepEqual(await gateway.setSessionThinking({
    sessionKey: "sdk:s1",
    thinking: { enabled: true, mode: "medium", budgetTokens: 2048 },
  }), { applied: true });
  assert.deepEqual(received, {
    sessionKey: "sdk:s1",
    thinking: { enabled: true, mode: "medium", budgetTokens: 2048 },
  });

  await router.getOrCreate({ sessionKey: "sdk:s1", channelKey: "api_server" });
  assert.equal(creates, 2, "the next turn must rebuild the session with the new adapter config");
  await assert.rejects(
    () => gateway.setSessionThinking({ sessionKey: "sdk:s1", thinking: { enabled: true, budgetTokens: -1 } }),
    { code: "INVALID_THINKING_CONFIG" },
  );
  router.shutdown();
});

test("SDK session settings wire config rejects unsupported source and credential-like fields", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:settings-wire") });
  const gateway = new InProcessGateway(router, {
    setSdkSessionConfig: async () => ({ changed: true }),
  });

  const invalidSource: any[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:settings-wire",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { settingSources: ["remote" as any] },
  })) invalidSource.push(event);
  assert.equal(invalidSource[0]?.type, "error");
  assert.equal((invalidSource[0] as any)?.code, "INVALID_SDK_SETTING_SOURCES");

  const invalidCredential: any[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:settings-wire",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { settings: { model: { apiKey: "nope" } } as any },
  })) invalidCredential.push(event);
  assert.equal(invalidCredential[0]?.type, "error");
  assert.equal((invalidCredential[0] as any)?.code, "UNSUPPORTED_SDK_SETTING");

  const invalidSubagentModel: any[] = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:settings-wire",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { settings: { agent: { subagents: { default: 42 } } } as any },
  })) invalidSubagentModel.push(event);
  assert.equal(invalidSubagentModel[0]?.type, "error");
  assert.equal((invalidSubagentModel[0] as any)?.code, "INVALID_SDK_SETTINGS");
  router.shutdown();
});

test("SDK thinking and rewind controls reject mutation during an active turn", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:s2") });
  assert.equal(router.beginTurn("sdk:s2", "run-1"), true);
  const gateway = new InProcessGateway(router, {
    setSessionThinking: async () => ({ applied: true }),
    rewindFiles: async () => ({ canRewind: true }),
  });

  await assert.rejects(
    () => gateway.setSessionThinking({ sessionKey: "sdk:s2", thinking: null }),
    { code: "SESSION_BUSY" },
  );
  await assert.rejects(
    () => gateway.rewindFiles({ sessionKey: "sdk:s2", userMessageId: "message-1" }),
    { code: "SESSION_BUSY" },
  );
  router.endTurn("sdk:s2", "run-1");
  router.shutdown();
});

test("Gateway owns deferred SDK hook delivery, idempotency, expiry and context-only effects", async () => {
  const steers: Array<{ itemId: string; text: string }> = [];
  const session = {
    abort() {},
    snapshot() {
      return { sessionId: "sdk:async-hooks", messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
    steer(input: { itemId: string; message: { content: Array<{ type: string; text?: string }> } }) {
      steers.push({ itemId: input.itemId, text: input.message.content[0]?.text ?? "" });
      return { accepted: true };
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  await router.getOrCreate({ sessionKey: "sdk:async-hooks", channelKey: "api_server" });
  const gateway = new InProcessGateway(router);
  assert.equal((await gateway.describeServer()).capabilities?.includes("async_hook_result"), true);

  assert.equal(router.beginTurn("sdk:async-hooks", "run-async-1"), true);
  gateway.registerAsyncHook({
    sessionKey: "sdk:async-hooks",
    hookName: "http",
    hookEvent: "UserPromptSubmit",
    invocationId: "async-1",
    timeoutMs: 1_000,
    includeHookEvents: false,
  });
  await assert.rejects(
    () => gateway.submitAsyncHookResult({
      sessionKey: "sdk:async-hooks",
      invocationId: "async-1",
      output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ok", updatedInput: {} } } as any,
    }),
    { code: "UNSUPPORTED_ASYNC_HOOK_EFFECT" },
  );
  assert.deepEqual(await gateway.submitAsyncHookResult({
    sessionKey: "sdk:async-hooks",
    invocationId: "async-1",
    output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "A policy check completed." } },
  }), { invocationId: "async-1", status: "delivered" });
  assert.deepEqual(await gateway.submitAsyncHookResult({
    sessionKey: "sdk:async-hooks",
    invocationId: "async-1",
    output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "must not apply twice" } },
  }), { invocationId: "async-1", status: "duplicate" });
  assert.deepEqual(steers, [{
    itemId: "async-hook:async-1",
    text: "<async_hook_context event=\"UserPromptSubmit\">\nA policy check completed.\n</async_hook_context>",
  }]);

  gateway.registerAsyncHook({
    sessionKey: "sdk:async-hooks",
    hookName: "http",
    hookEvent: "PostToolUse",
    invocationId: "async-timeout",
    timeoutMs: 1,
    includeHookEvents: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await gateway.submitAsyncHookResult({
    sessionKey: "sdk:async-hooks",
    invocationId: "async-timeout",
    output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "timed out" } },
  }), { invocationId: "async-timeout", status: "expired" });
  assert.equal(steers.length, 1, "an expired deadline must not receive deferred context");

  gateway.registerAsyncHook({
    sessionKey: "sdk:async-hooks",
    hookName: "http",
    hookEvent: "PreToolUse",
    invocationId: "async-expired",
    timeoutMs: 1_000,
    includeHookEvents: false,
  });
  router.endTurn("sdk:async-hooks", "run-async-1");
  assert.deepEqual(await gateway.submitAsyncHookResult({
    sessionKey: "sdk:async-hooks",
    invocationId: "async-expired",
    output: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "too late" } },
  }), { invocationId: "async-expired", status: "expired" });
  assert.equal(steers.length, 1, "an ended turn must not receive deferred context");
  router.shutdown();
});

test("SDK output-style controls are Gateway-owned and reject active-turn mutation", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:style") });
  const calls: Array<{ kind: string; input: unknown }> = [];
  const gateway = new InProcessGateway(router, {
    outputStylesList: async (input) => {
      calls.push({ kind: "list", input });
      return { styles: [{ name: "concise", description: "Short answers", source: "project" }], selected: "concise" };
    },
    setOutputStyle: async (input) => {
      calls.push({ kind: "set", input });
      return { applied: true, ...(input.name ? { selected: input.name } : {}) };
    },
    reloadOutputStyles: async (input) => {
      calls.push({ kind: "reload", input });
      return { reloaded: true, changed: ["concise"] };
    },
  });
  assert.equal((await gateway.describeServer()).capabilities?.includes("output_styles_list"), true);
  assert.equal((await gateway.describeServer()).capabilities?.includes("set_output_style"), true);
  assert.equal((await gateway.describeServer()).capabilities?.includes("reload_output_styles"), true);
  assert.deepEqual(await gateway.outputStylesList({ sessionKey: "sdk:style", projectKey: "/tmp/project" }), {
    styles: [{ name: "concise", description: "Short answers", source: "project" }],
    selected: "concise",
  });
  assert.deepEqual(await gateway.setOutputStyle({ sessionKey: "sdk:style", projectKey: "/tmp/project", name: "concise" }), {
    applied: true,
    selected: "concise",
  });
  assert.deepEqual(await gateway.reloadOutputStyles({ projectKey: "/tmp/project" }), { reloaded: true, changed: ["concise"] });
  assert.equal(router.beginTurn("sdk:style", "run-style"), true);
  await assert.rejects(
    () => gateway.setOutputStyle({ sessionKey: "sdk:style", name: "concise" }),
    { code: "SESSION_BUSY" },
  );
  router.endTurn("sdk:style", "run-style");
  assert.deepEqual(calls.map((call) => call.kind), ["list", "set", "reload"]);
  router.shutdown();
});

test("SDK usage snapshot projects the Router-owned aggregate without client-side accounting", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:usage") });
  const expected = {
    scope: "session" as const,
    sessionId: "sdk:usage",
    aggregate: {
      totalRequests: 2,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      totalCost: 0.004,
      totalBaselineCost: 0.006,
      totalSavedCost: 0.002,
      perScenario: { default: 2 },
      perModel: { "test/model": 0.004 },
      perProvider: { test: 0.004 },
      perTier: { default: 2 },
      perRole: { main: 2 },
      costSources: { provider_reported: 2 },
    },
  };
  const gateway = new InProcessGateway(router, { usageSnapshot: async () => expected });
  assert.equal((await gateway.describeServer()).capabilities?.includes("usage_snapshot"), true);
  assert.deepEqual(await gateway.usageSnapshot({ sessionKey: "sdk:usage", projectKey: "/tmp/project" }), expected);
  router.shutdown();
});

test("SDK model usage snapshot advertises and forwards the Gateway-owned aggregate", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:model-usage") });
  const expected = {
    scope: "session" as const,
    sessionId: "sdk:model-usage",
    models: [{
      provider: "test",
      model: "model-a",
      totalRequests: 1,
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 20,
      totalCost: 0.004,
      costSources: { provider_reported: 1 },
      roles: {
        main: {
          totalRequests: 1,
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 20,
          totalCost: 0.004,
          costSources: { provider_reported: 1 },
        },
      },
    }],
  };
  const gateway = new InProcessGateway(router, { modelUsageSnapshot: async () => expected });
  assert.equal((await gateway.describeServer()).capabilities?.includes("model_usage_snapshot"), true);
  assert.deepEqual(await gateway.modelUsageSnapshot({ sessionKey: "sdk:model-usage", projectKey: "/tmp/project" }), expected);
  router.shutdown();
});

test("SDK updateSettings is a Gateway-hosted global config control", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:settings") });
  const calls: unknown[] = [];
  const gateway = new InProcessGateway(router, {
    updateSettings: async (input) => {
      calls.push(input);
      return { applied: ["agent.maxContextTokens"], cleared: [], changedPaths: ["agent.maxContextTokens"] };
    },
  });
  assert.equal((await gateway.describeServer()).capabilities?.includes("update_settings"), true);
  assert.deepEqual(await gateway.updateSettings!({
    source: "localSettings",
    settings: { agent: { maxContextTokens: 4096 } },
  }), { applied: ["agent.maxContextTokens"], cleared: [], changedPaths: ["agent.maxContextTokens"] });
  assert.deepEqual(calls, [{ source: "localSettings", settings: { agent: { maxContextTokens: 4096 } } }]);
  await assert.rejects(
    () => gateway.updateSettings!({ source: "unsupported" as "localSettings", settings: {} }),
    { code: "INVALID_SETTINGS_SOURCE" },
  );
  router.shutdown();
});

test("SDK resolveSettings is a redacted Gateway-hosted read control", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:resolved-settings") });
  const expected = {
    schemaVersion: 1,
    version: 3,
    loadedAt: "2026-09-09T00:00:00.000Z",
    contentHash: "redacted-hash",
    config: { model: { providers: { test: { apiKey: "<redacted>" } } } },
    sources: [],
    diagnostics: [],
  };
  const gateway = new InProcessGateway(router, { resolveSettings: async () => expected });
  assert.equal((await gateway.describeServer()).capabilities?.includes("resolve_settings"), true);
  assert.deepEqual(await gateway.resolveSettings!(), expected);
  router.shutdown();
});

test("SDK rewind is a typed adapter over the host file-history owner", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:s3") });
  let received: unknown;
  const expected = { canRewind: true, filesChanged: ["/tmp/a.ts"], insertions: 3, deletions: 1 };
  const gateway = new InProcessGateway(router, {
    rewindFiles: async (input) => {
      received = input;
      return expected;
    },
  });
  const input = { sessionKey: "sdk:s3", projectKey: "/tmp/project", userMessageId: "message-1", dryRun: false };
  assert.deepEqual(await gateway.rewindFiles(input), expected);
  assert.deepEqual(received, input);
  router.shutdown();
});

test("SDK seedReadState is Gateway-owned, validates input, and rejects active turns", async () => {
  const calls: Array<{ path: string; mtime: number }> = [];
  const session = {
    abort() {},
    snapshot() {
      return { sessionId: "sdk:seed", messages: [], usage: {}, status: "idle", permissionDenials: [] };
    },
    async seedReadState(path: string, mtime: number) {
      calls.push({ path, mtime });
      return { applied: true };
    },
  } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => session });
  const gateway = new InProcessGateway(router);

  assert.deepEqual(await gateway.seedReadState({
    sessionKey: "sdk:seed",
    projectKey: "/tmp/project",
    path: "src/index.ts",
    mtime: 1_725_000_000_123,
  }), { applied: true });
  assert.deepEqual(calls, [{ path: "src/index.ts", mtime: 1_725_000_000_123 }]);

  await assert.rejects(
    () => gateway.seedReadState({ sessionKey: "sdk:seed", path: "src/index.ts", mtime: 1.5 }),
    { code: "INVALID_FILE_MTIME" },
  );
  assert.equal(router.beginTurn("sdk:seed", "run-seed"), true);
  await assert.rejects(
    () => gateway.seedReadState({ sessionKey: "sdk:seed", path: "src/index.ts", mtime: 1 }),
    { code: "SESSION_BUSY" },
  );
  router.endTurn("sdk:seed", "run-seed");
  router.shutdown();
});

test("SDK background controls keep task ownership in the project runtime", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:task") });
  const calls: unknown[] = [];
  const gateway = new InProcessGateway(router, {
    stopBackgroundTask: async (input) => {
      calls.push({ kind: "stop", input });
      return { stopped: true, status: "cancelled" };
    },
    backgroundTasks: async (input) => {
      calls.push({ kind: "background", input });
      return { backgrounded: false, reason: "no_foreground_tasks" };
    },
  });
  assert.deepEqual(await gateway.stopBackgroundTask({ sessionKey: "sdk:task", taskId: "task-1", projectKey: "/tmp/project" }), {
    stopped: true,
    status: "cancelled",
  });
  assert.deepEqual(await gateway.backgroundTasks({ sessionKey: "sdk:task", projectKey: "/tmp/project" }), {
    backgrounded: false,
    reason: "no_foreground_tasks",
  });
  assert.deepEqual(calls, [
    { kind: "stop", input: { sessionKey: "sdk:task", taskId: "task-1", projectKey: "/tmp/project" } },
    { kind: "background", input: { sessionKey: "sdk:task", projectKey: "/tmp/project" } },
  ]);
  router.shutdown();
});

test("SDK MCP controls are session-scoped, evict stale adapters, and preserve server ownership", async () => {
  let creates = 0;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(`session-${++creates}`),
  });
  await router.getOrCreate({ sessionKey: "sdk:mcp", channelKey: "api_server" });
  const calls: Array<{ kind: string; input: unknown }> = [];
  const gateway = new InProcessGateway(router, {
    setMcpServers: async (input) => {
      calls.push({ kind: "set", input });
      return { added: ["tickets"], removed: [], errors: [] };
    },
    reconnectMcpServer: async (input) => { calls.push({ kind: "reconnect", input }); },
    toggleMcpServer: async (input) => { calls.push({ kind: "toggle", input }); },
  });

  const config = {
    sessionKey: "sdk:mcp",
    projectKey: "/tmp/project",
    servers: { tickets: { type: "stdio" as const, command: "ticket-mcp", args: ["--stdio"] } },
  };
  assert.deepEqual(await gateway.setMcpServers(config), { added: ["tickets"], removed: [], errors: [] });
  await router.getOrCreate({ sessionKey: "sdk:mcp", channelKey: "api_server" });
  assert.equal(creates, 2, "MCP configuration must recreate the session before its next native turn");
  await gateway.reconnectMcpServer({ sessionKey: "sdk:mcp", projectKey: "/tmp/project", serverName: "tickets" });
  await gateway.toggleMcpServer({ sessionKey: "sdk:mcp", projectKey: "/tmp/project", serverName: "tickets", enabled: false });
  assert.deepEqual(calls.map((call) => call.kind), ["set", "reconnect", "toggle"]);

  assert.equal(router.beginTurn("sdk:mcp", "run-mcp"), true);
  await assert.rejects(() => gateway.toggleMcpServer({ sessionKey: "sdk:mcp", serverName: "tickets", enabled: true }), {
    code: "SESSION_BUSY",
  });
  router.endTurn("sdk:mcp", "run-mcp");
  router.shutdown();
});

test("SDK MCP permission override validates modes, returns conservative auto warning, and rejects active turns", async () => {
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => fakeSession("sdk:mcp-perm") });
  const calls: unknown[] = [];
  const gateway = new InProcessGateway(router, {
    setMcpPermissionModeOverride: async (input) => {
      calls.push(input);
      return input.mode === "auto" ? { warning: "conservative" } : {};
    },
  });
  assert.deepEqual(await gateway.setMcpPermissionModeOverride({
    sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "default",
  }), {});
  assert.deepEqual(await gateway.setMcpPermissionModeOverride({
    sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "auto",
  }), { warning: "conservative" });
  assert.deepEqual(await gateway.setMcpPermissionModeOverride({
    sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: null,
  }), {});
  assert.deepEqual(calls, [
    { sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "default" },
    { sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "auto" },
    { sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: null },
  ]);
  await assert.rejects(
    () => gateway.setMcpPermissionModeOverride({ sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "bogus" as never }),
    { code: "INVALID_MCP_PERMISSION_MODE" },
  );
  assert.equal(router.beginTurn("sdk:mcp-perm", "run-1"), true);
  await assert.rejects(
    () => gateway.setMcpPermissionModeOverride({ sessionKey: "sdk:mcp-perm", serverName: "tickets", mode: "default" }),
    { code: "SESSION_BUSY" },
  );
  router.endTurn("sdk:mcp-perm", "run-1");
  router.shutdown();
});

test("SDK applyFlagSettings is validated, session-scoped, and evicts cached sessions", async () => {
  let creates = 0;
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(`sdk:flags-${++creates}`),
  });
  await router.getOrCreate({ sessionKey: "sdk:flags", channelKey: "api_server" });
  let received: unknown;
  const gateway = new InProcessGateway(router, {
    applyFlagSettings: async (input) => {
      received = input;
      return { applied: ["effortLevel"], cleared: [] };
    },
  });

  assert.deepEqual(await gateway.applyFlagSettings({
    sessionKey: "sdk:flags",
    projectKey: "/tmp/project",
    settings: { effortLevel: "high" },
  }), { applied: ["effortLevel"], cleared: [] });
  assert.deepEqual(received, {
    sessionKey: "sdk:flags",
    projectKey: "/tmp/project",
    settings: { effortLevel: "high" },
  });
  await router.getOrCreate({ sessionKey: "sdk:flags", channelKey: "api_server" });
  assert.equal(creates, 2);

  await assert.rejects(
    () => gateway.applyFlagSettings({ sessionKey: "sdk:flags", settings: { model: "test/test" } }),
    { code: "UNSUPPORTED_FLAG_SETTING" },
  );
  assert.equal(router.beginTurn("sdk:flags", "run-flags"), true);
  await assert.rejects(
    () => gateway.applyFlagSettings({ sessionKey: "sdk:flags", settings: { effortLevel: "low" } }),
    { code: "SESSION_BUSY" },
  );
  router.endTurn("sdk:flags", "run-flags");
  router.shutdown();
});

test("submit_turn applies SDK session config before creating the native session", async () => {
  const calls: string[] = [];
  let config: unknown;
  const session = {
    async *submit() {
      yield { type: "input_accepted", sessionId: "sdk:s5", turnId: "run-1", messages: [] };
      yield {
        type: "turn_completed",
        sessionId: "sdk:s5",
        turnId: "run-1",
        result: { stopReason: "completed", usage: {} },
      };
    },
  } as unknown as AgentSession;
  const router = {
    hasActiveTurn: () => false,
    beginTurn: () => true,
    close: async () => { calls.push("close"); },
    getOrCreate: async () => { calls.push("create"); return session; },
    endTurn: () => { calls.push("end"); },
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    setSdkSessionConfig: (_sessionKey, received) => {
      calls.push("config");
      config = received;
      return { changed: true };
    },
  });

  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:s5",
    channelKey: "api_server",
    message: "hello",
    runId: "run-1",
    sdkSessionConfig: {
      systemPrompt: "review changes",
      appendSystemPrompt: "Keep answers concise.",
      toolAliases: { Bash: "sandbox_bash" },
      additionalWorkingDirectories: ["/workspace/shared"],
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
      },
      hooks: {
        url: "http://127.0.0.1:43123/pilotdeck-sdk-hooks",
        headers: { authorization: "Bearer test-token" },
        events: { UserPromptSubmit: [{ matcher: "UserPromptSubmit", timeout: 5 }] },
      },
    },
  })) events.push(event.type);

  assert.deepEqual(calls.slice(0, 3), ["config", "close", "create"]);
  assert.deepEqual(config, {
    systemPrompt: "review changes",
    appendSystemPrompt: "Keep answers concise.",
    toolAliases: { Bash: "sandbox_bash" },
    additionalWorkingDirectories: ["/workspace/shared"],
    outputFormat: {
      type: "json_schema",
      schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
    },
    hooks: {
      url: "http://127.0.0.1:43123/pilotdeck-sdk-hooks",
      headers: { authorization: "Bearer test-token" },
      events: { UserPromptSubmit: [{ matcher: "UserPromptSubmit", timeout: 5 }] },
    },
  });
  assert.ok(events.includes("turn_completed"));
});

test("submit_turn validates and forwards maxBudgetUsd without making it SDK-client state", async () => {
  let received: unknown;
  const session = {
    async *submit(_input: unknown, options: unknown) {
      received = options;
      yield { type: "input_accepted", sessionId: "sdk:budget", turnId: "run-budget", messages: [] };
      yield {
        type: "turn_completed",
        sessionId: "sdk:budget",
        turnId: "run-budget",
        result: {
          type: "success",
          sessionId: "sdk:budget",
          turnId: "run-budget",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-09T00:00:00.000Z",
          completedAt: "2026-09-09T00:00:00.001Z",
        },
      };
    },
  } as unknown as AgentSession;
  const router = {
    hasActiveTurn: () => false,
    beginTurn: () => true,
    getOrCreate: async () => session,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router);

  for await (const _event of gateway.submitTurn({
    sessionKey: "sdk:budget",
    channelKey: "api_server",
    message: "hello",
    runId: "run-budget",
    maxBudgetUsd: 0.125,
  })) { /* consume */ }
  assert.equal((received as { maxBudgetUsd?: number }).maxBudgetUsd, 0.125);

  const invalid = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:budget",
    channelKey: "api_server",
    message: "hello",
    maxBudgetUsd: 0,
  })) invalid.push(event);
  assert.equal(invalid[0]?.type, "error");
  assert.equal((invalid[0] as { code?: string }).code, "INVALID_MAX_BUDGET_USD");
});

test("Gateway owns taskBudget accounting across turns and never lets the SDK supply spent cost", async () => {
  let received: unknown;
  let nativeTurns = 0;
  const settled: Array<{ runId: string; turnSpentUsd: number }> = [];
  let spentUsd = 0.1;
  const session = {
    async *submit(_input: unknown, options: unknown) {
      nativeTurns += 1;
      received = options;
      yield { type: "input_accepted", sessionId: "sdk:task-budget", turnId: "run-1", messages: [] };
      yield {
        type: "turn_completed",
        sessionId: "sdk:task-budget",
        turnId: "run-1",
        result: {
          type: "success",
          sessionId: "sdk:task-budget",
          turnId: "run-1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-09-09T00:00:00.000Z",
          completedAt: "2026-09-09T00:00:00.001Z",
          budget: { turnSpentUsd: 0.05, taskBudgetUsd: 0.2, taskSpentUsd: 0.15 },
        },
      };
    },
  } as unknown as AgentSession;
  const router = {
    hasActiveTurn: () => false,
    beginTurn: () => true,
    getOrCreate: async () => session,
    endTurn: () => undefined,
  } as unknown as SessionRouter;
  const gateway = new InProcessGateway(router, {
    setSdkSessionConfig: () => ({ changed: false }),
    taskBudgetSnapshot: () => ({ totalUsd: 0.2, spentUsd }),
    recordTaskBudgetSpend: ({ runId, turnSpentUsd }) => {
      settled.push({ runId, turnSpentUsd });
    },
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "sdk:task-budget",
    channelKey: "api_server",
    message: "hello",
    runId: "run-1",
    sdkSessionConfig: { taskBudget: { total: 0.2 } },
  })) { /* consume */ }
  assert.equal((received as { taskBudgetUsd?: number }).taskBudgetUsd, 0.2);
  assert.equal((received as { initialTaskBudgetSpentUsd?: number }).initialTaskBudgetSpentUsd, 0.1);
  assert.equal((received as { turnId?: string }).turnId, "run-1");
  assert.deepEqual(settled, [{ runId: "run-1", turnSpentUsd: 0.05 }]);

  spentUsd = 0.2;
  const exhausted = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "sdk:task-budget",
    channelKey: "api_server",
    message: "must not reach the native session",
    runId: "run-2",
  })) exhausted.push(event);
  assert.equal(nativeTurns, 1);
  assert.equal((exhausted[0] as { code?: string }).code, "agent_task_budget_reached");
  assert.equal((exhausted[1] as { finishReason?: string }).finishReason, "task_budget");
});

test("SDK session config fails before a native turn starts when unavailable or malformed", async () => {
  const router = {
    hasActiveTurn: () => false,
    beginTurn: () => { throw new Error("must not begin"); },
  } as unknown as SessionRouter;
  const unavailable = new InProcessGateway(router);
  const unavailableEvents = [];
  for await (const event of unavailable.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { systemPrompt: "hello" },
  })) unavailableEvents.push(event);
  assert.equal(unavailableEvents[0]?.type, "error");
  assert.equal((unavailableEvents[0] as any)?.code, "CAPABILITY_UNAVAILABLE");

  const malformed = new InProcessGateway(router, { setSdkSessionConfig: () => ({ changed: false }) });
  const malformedEvents = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { additionalWorkingDirectories: ["relative"] },
  })) malformedEvents.push(event);
  assert.equal(malformedEvents[0]?.type, "error");
  assert.equal((malformedEvents[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidOutput = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { outputFormat: { type: "json_schema", schema: { type: "object", required: [42 as any] } } },
  })) invalidOutput.push(event);
  assert.equal(invalidOutput[0]?.type, "error");
  assert.equal((invalidOutput[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidAppend = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { appendSystemPrompt: 42 as any },
  })) invalidAppend.push(event);
  assert.equal((invalidAppend[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidAgentModel = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: {
      agents: {
        reviewer: { description: "Review changes.", prompt: "Inspect the diff.", model: 42 as any },
      },
    },
  })) invalidAgentModel.push(event);
  assert.equal((invalidAgentModel[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidHooks = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: {
      hooks: {
        url: "ftp://invalid.example/hooks",
        events: { NotANativeHook: [{ timeout: 0 }] },
      },
    },
  })) invalidHooks.push(event);
  assert.equal((invalidHooks[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidPlan = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { planModeInstructions: 42 as any },
  })) invalidPlan.push(event);
  assert.equal((invalidPlan[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidPermission = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { permissionMode: "bypassPermissions" as any },
  })) invalidPermission.push(event);
  assert.equal((invalidPermission[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidSkills = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { skills: ["review", "review"] },
  })) invalidSkills.push(event);
  assert.equal((invalidSkills[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidTaskBudget = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { taskBudget: { total: 0 } },
  })) invalidTaskBudget.push(event);
  assert.equal((invalidTaskBudget[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");

  const invalidTaskBudgetScope = [];
  for await (const event of malformed.submitTurn({
    sessionKey: "sdk:s6",
    channelKey: "api_server",
    message: "hello",
    sdkSessionConfig: { taskBudget: { total: 1, scope: "workspace" as any } },
  })) invalidTaskBudgetScope.push(event);
  assert.equal((invalidTaskBudgetScope[0] as any)?.code, "INVALID_SDK_SESSION_CONFIG");
});

test("RemoteGateway forwards SDK controls without changing wire semantics", async () => {
  const requests: Array<{ method: string; input: unknown }> = [];
  const remote = new RemoteGateway({
    request: async (method: string, input: unknown) => {
      requests.push({ method, input });
      if (method === "rewind_files") return { canRewind: false, error: "no snapshot" };
      if (method === "update_settings") return { applied: ["agent.maxContextTokens"], cleared: [], changedPaths: ["agent.maxContextTokens"] };
      if (method === "resolve_settings") return { schemaVersion: 1, version: 1, loadedAt: "2026-09-09T00:00:00.000Z", contentHash: "x", config: {}, sources: [], diagnostics: [] };
      if (method === "hook_async_result") return { invocationId: "async-hook-1", status: "delivered" };
      return { applied: true };
    },
  } as unknown as GatewayWsClient);
  await remote.setSessionThinking({ sessionKey: "sdk:s4", thinking: { enabled: false, mode: "off" } });
  assert.deepEqual(await remote.rewindFiles({ sessionKey: "sdk:s4", userMessageId: "message-2", dryRun: true }), {
    canRewind: false,
    error: "no snapshot",
  });
  assert.deepEqual(await remote.updateSettings({
    source: "localSettings",
    settings: { agent: { maxContextTokens: 4096 } },
  }), { applied: ["agent.maxContextTokens"], cleared: [], changedPaths: ["agent.maxContextTokens"] });
  assert.deepEqual(await remote.resolveSettings(), {
    schemaVersion: 1, version: 1, loadedAt: "2026-09-09T00:00:00.000Z", contentHash: "x", config: {}, sources: [], diagnostics: [],
  });
  assert.deepEqual(await remote.submitAsyncHookResult({
    sessionKey: "sdk:s4",
    invocationId: "async-hook-1",
    output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Use the approved deployment path." } },
  }), { invocationId: "async-hook-1", status: "delivered" });
  assert.deepEqual(await remote.seedReadState({ sessionKey: "sdk:s4", path: "src/index.ts", mtime: 1_725_000_000_123 }), { applied: true });
  assert.deepEqual(requests.map((request) => request.method), ["set_session_thinking", "rewind_files", "update_settings", "resolve_settings", "hook_async_result", "seed_read_state"]);
  assert.deepEqual(requests[4]?.input, {
    sessionKey: "sdk:s4",
    invocationId: "async-hook-1",
    output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Use the approved deployment path." } },
  });
});

test("RemoteGateway forwards SDK MCP control messages without transforming ownership", async () => {
  const requests: Array<{ method: string; input: unknown }> = [];
  const remote = new RemoteGateway({
    request: async (method: string, input: unknown) => {
      requests.push({ method, input });
      return method === "set_mcp_servers"
        ? { added: ["tickets"], removed: [], errors: [] }
        : method === "set_mcp_permission_mode_override"
          ? { warning: "conservative" }
          : method === "apply_flag_settings"
            ? { applied: ["effortLevel"], cleared: [] }
          : { ok: true };
    },
  } as unknown as GatewayWsClient);
  assert.deepEqual(await remote.setMcpServers({
    sessionKey: "sdk:mcp-remote",
    servers: { tickets: { type: "stdio", command: "ticket-mcp" } },
  }), { added: ["tickets"], removed: [], errors: [] });
  await remote.reconnectMcpServer({ sessionKey: "sdk:mcp-remote", serverName: "tickets" });
  await remote.toggleMcpServer({ sessionKey: "sdk:mcp-remote", serverName: "tickets", enabled: false });
  assert.deepEqual(await remote.setMcpPermissionModeOverride({
    sessionKey: "sdk:mcp-remote",
    serverName: "tickets",
    mode: "auto",
  }), { warning: "conservative" });
  assert.deepEqual(await remote.applyFlagSettings({
    sessionKey: "sdk:mcp-remote",
    settings: { effortLevel: "high" },
  }), { applied: ["effortLevel"], cleared: [] });
  assert.deepEqual(requests.map((request) => request.method), [
    "set_mcp_servers",
    "mcp_server_reconnect",
    "mcp_server_toggle",
    "set_mcp_permission_mode_override",
    "apply_flag_settings",
  ]);
});
