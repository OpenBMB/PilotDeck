import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import type { MemoryResolver } from "../../../src/context/memory/MemoryResolver.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";

test("provider and model overrides retain configured temperature, speed, and thinking defaults", async () => {
  const thinking = { enabled: true, mode: "high" as const };
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "default-model",
    cwd: "/workspace/project",
    temperature: 0.35,
    thinking,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const loop = new AgentLoop(config, {
    router: {} as AgentRuntimeDependencies["router"],
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  });
  const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const input: AgentLoopInput = {
    sessionId: "session-1",
    turnId: "turn-1",
    messages,
    modelOverride: { provider: "anthropic", model: "selected-model", speed: 0.7 },
  };

  const request = await (loop as unknown as {
    createModelRequest(
      messages: CanonicalMessage[],
      input: AgentLoopInput,
      options: { emitInstructionEvents?: boolean },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest(messages, input, { emitInstructionEvents: false });

  assert.equal(request.provider, "anthropic");
  assert.equal(request.model, "selected-model");
  assert.equal(request.temperature, 0.35);
  assert.equal(request.speed, 0.7);
  assert.deepEqual(request.thinking, thinking);
});

test("one-turn thinking overrides the runtime default", async () => {
  const config: AgentRuntimeConfig = {
    provider: "openai",
    model: "default-model",
    cwd: "/workspace/project",
    thinking: { enabled: false, mode: "off" },
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const loop = new AgentLoop(config, {
    router: {} as AgentRuntimeDependencies["router"],
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  });
  const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const input: AgentLoopInput = {
    sessionId: "session-thinking",
    turnId: "turn-thinking",
    messages,
    thinking: { enabled: true, mode: "medium" },
  };

  const request = await (loop as unknown as {
    createModelRequest(
      messages: CanonicalMessage[],
      input: AgentLoopInput,
      options: { emitInstructionEvents?: boolean },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest(messages, input, { emitInstructionEvents: false });

  assert.deepEqual(request.thinking, { enabled: true, mode: "medium" });
});

test("plan-mode reminder is appended after projection and recent3 cache indices are computed", async () => {
  const config: AgentRuntimeConfig = {
    provider: "modelbest",
    model: "claude-test",
    cwd: "/workspace/project",
    systemPrompt: "stable system",
    permissionMode: "plan",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "plan",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const loop = new AgentLoop(config, {
    router: {} as AgentRuntimeDependencies["router"],
    context: new DefaultContextRuntime(),
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
    getModelProtocol: () => "anthropic",
    getModelSupportsPromptCache: () => true,
  });
  const messages: CanonicalMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{ type: "text" as const, text: `message-${index}` }],
  }));
  const input: AgentLoopInput = {
    sessionId: "plan-cache-session",
    turnId: "plan-cache-turn",
    messages,
  };

  const request = await (loop as unknown as {
    createModelRequest(
      messages: CanonicalMessage[],
      input: AgentLoopInput,
      options: { emitInstructionEvents?: boolean },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest(messages, input, { emitInstructionEvents: false });

  assert.equal(request.messages.length, 6);
  assert.equal(request.messages[5]?.metadata?.purpose, "plan_mode_reminder");
  assert.deepEqual(request.cachePlan?.messages, [3, 4, 5]);
  assert.deepEqual(request.cacheBreakpoints, [3, 4, 5]);
});

test("plan-mode reminder does not consume the context message limit", async () => {
  const config: AgentRuntimeConfig = {
    provider: "modelbest",
    model: "claude-test",
    cwd: "/workspace/project",
    permissionMode: "plan",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "plan",
      canPrompt: false,
      bypassAvailable: true,
    }),
    maxContextMessages: 1,
  };
  const loop = new AgentLoop(config, {
    router: {} as AgentRuntimeDependencies["router"],
    context: new DefaultContextRuntime(),
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
    getModelProtocol: () => "anthropic",
    getModelSupportsPromptCache: () => true,
  });
  const input: AgentLoopInput = {
    sessionId: "plan-limit-session",
    turnId: "plan-limit-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "REAL USER REQUEST" }] }],
  };

  const request = await (loop as unknown as {
    createModelRequest(
      messages: CanonicalMessage[],
      input: AgentLoopInput,
      options: { emitInstructionEvents?: boolean },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest(input.messages, input, { emitInstructionEvents: false });

  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0]?.content[0]?.type, "text");
  assert.equal(request.messages[0]?.content[0]?.text, "REAL USER REQUEST");
  assert.equal(request.messages[1]?.metadata?.purpose, "plan_mode_reminder");
  assert.deepEqual(request.cacheBreakpoints, [0, 1]);
});

test("plan-mode memory retrieval uses the real user request", async () => {
  let query: string | undefined;
  const memoryResolver: MemoryResolver = {
    async retrieve(input) {
      query = input.query;
      return { systemContext: "relevant memory", diagnostics: [] };
    },
    async captureTurn() {},
  };
  const config: AgentRuntimeConfig = {
    provider: "modelbest",
    model: "claude-test",
    cwd: "/workspace/project",
    permissionMode: "plan",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "plan",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const loop = new AgentLoop(config, {
    router: {} as AgentRuntimeDependencies["router"],
    context: new DefaultContextRuntime({ memoryResolver }),
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
  });
  const input: AgentLoopInput = {
    sessionId: "plan-memory-session",
    turnId: "plan-memory-turn",
    messages: [{ role: "user", content: [{ type: "text", text: "REAL USER REQUEST" }] }],
  };

  await (loop as unknown as {
    createModelRequest(
      messages: CanonicalMessage[],
      input: AgentLoopInput,
      options: { emitInstructionEvents?: boolean },
    ): Promise<CanonicalModelRequest>;
  }).createModelRequest(input.messages, input, { emitInstructionEvents: false });

  assert.equal(query, "REAL USER REQUEST");
});
