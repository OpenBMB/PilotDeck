import assert from "node:assert/strict";
import test from "node:test";

import { buildAskModeAgentToolSchema, createAgentTool } from "../../../src/tool/builtin/agent.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type { PilotDeckSubagentForkApi, PilotDeckToolRuntimeContext } from "../../../src/tool/index.js";

function context(fork?: PilotDeckSubagentForkApi): PilotDeckToolRuntimeContext {
  return {
    sessionId: "parent", turnId: "turn", cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(), mode: "bypassPermissions", canPrompt: false, bypassAvailable: true,
    }),
    subagent: fork,
  };
}

test("agent forwards an explicit model reference without splitting nested model IDs", async () => {
  let received: Parameters<PilotDeckSubagentForkApi["fork"]>[0] | undefined;
  const fork: PilotDeckSubagentForkApi = {
    depth: 0, maxSubagentDepth: 1,
    listDefinitions: () => [{ id: "explore", description: "Read only" }],
    isAllowedDefinition: () => true,
    fork: async (args) => {
      received = args;
      return { markdown: "ok", usage: {}, turns: 1, durationMs: 1 };
    },
  };
  await createAgentTool().execute({
    description: "Inspect image", prompt: "Read image.png", subagent_type: "explore",
    model: "gateway/vendor/vision",
  }, context(fork));
  assert.equal(received?.model, "gateway/vendor/vision");
});

test("normal and ask-mode agent schemas expose an optional model", () => {
  for (const schema of [createAgentTool().inputSchema, buildAskModeAgentToolSchema().inputSchema]) {
    const properties = schema.properties as Record<string, { type: string }>;
    assert.equal(properties.model?.type, "string");
    assert.ok(!(schema.required as string[]).includes("model"));
  }
});

test("standalone agent rejects explicit model selection instead of ignoring it", async () => {
  let calls = 0;
  const tool = createAgentTool({ model: { async *stream() { calls++; yield { type: "text_delta", text: "ok" }; } } });
  await assert.rejects(tool.execute({ description: "Inspect", prompt: "Inspect", model: "test/vision" }, context()),
    { code: "unsupported_tool" });
  assert.equal(calls, 0);
});

test("agent rejects blank and non-string model arguments", async () => {
  for (const model of ["", "  ", 12, null]) {
    await assert.rejects(createAgentTool().execute({
      description: "Inspect", prompt: "Inspect", model: model as string,
    }, context()), { code: "invalid_tool_input" });
  }
});
