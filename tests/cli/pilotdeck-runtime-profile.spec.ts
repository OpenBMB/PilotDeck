import assert from "node:assert/strict";
import test from "node:test";

import { resolvePilotDeckRuntimeProfile } from "../../src/cli/PilotDeckRuntimeProfile.js";
import type { PilotAgentConfig } from "../../src/pilot/config/types.js";
import { DEFAULT_SANDBOX_MODE } from "../../src/tool/execution-world/SandboxPort.js";

test("runtime profile resolves configured execution, context, and interaction providers", () => {
  const profile = resolvePilotDeckRuntimeProfile({
    agent: agent({
      sandboxMode: "workspace-write",
      runtimeContextSurface: "system_prompt",
      interactionProfile: "disabled",
    }),
  });

  assert.equal(profile.sandboxMode, "workspace-write");
  assert.equal(profile.runtimeContextSurface, "system_prompt");
  assert.equal(profile.interaction.name, "disabled");
  assert.equal(profile.interaction.canPrompt, false);
});

test("runtime profile preserves explicit interaction override precedence", () => {
  const agentConfig = agent({ interactionProfile: "disabled" });

  assert.equal(resolvePilotDeckRuntimeProfile({
    agent: agentConfig,
    autoElicitation: true,
  }).interaction.name, "headless");
  assert.equal(resolvePilotDeckRuntimeProfile({
    agent: agentConfig,
    autoElicitation: true,
    interactionProfileOverride: "interactive",
  }).interaction.name, "interactive");
});

test("runtime profile uses native defaults when config omits a provider choice", () => {
  const profile = resolvePilotDeckRuntimeProfile({ agent: agent() });

  assert.equal(profile.sandboxMode, DEFAULT_SANDBOX_MODE);
  assert.equal(profile.runtimeContextSurface, "system_prompt");
  assert.equal(profile.interaction.name, "interactive");
});

function agent(overrides: Partial<PilotAgentConfig> = {}): PilotAgentConfig {
  return {
    model: { id: "test/test", provider: "test", model: "test" },
    ...overrides,
  };
}
