import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop, type AgentLoopInput } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
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
