import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { InstructionDiscovery } from "../../src/context/instructions/InstructionDiscovery.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { createWebSearchTool, type WebSearchProvider, type WebSearchOutput } from "../../src/tool/builtin/webSearch.js";
import type { PilotDeckToolDefinition } from "../../src/tool/index.js";
import { externalModel } from "./helpers.js";

test("real model receives instructions discovered from the isolated workspace", { timeout: 120_000 }, async () => {
  const { provider, model, runtime: modelRuntime } = externalModel();
  const root = await mkdtemp(path.join(tmpdir(), "pilotdeck-external-context-"));
  const workspace = path.join(root, "workspace");
  const pilotHome = path.join(root, "home");
  const marker = "PILOTDECK-CONTEXT-CANARY-42";
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(path.join(pilotHome, "PILOTDECK.md"), `Secret marker: ${marker}\n`, "utf8");
    const contextRuntime = new DefaultContextRuntime({
      instructionDiscovery: new InstructionDiscovery(workspace, workspace, pilotHome),
    });
    const context = await contextRuntime.prepareForModel({
      sessionId: "external-context",
      turnId: "turn-1",
      cwd: workspace,
      provider,
      model,
      permissionMode: "default",
      additionalWorkingDirectories: [],
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with only the secret marker from your instructions." }] }],
      tools: [],
    });
    assert.match(context.systemPrompt ?? "", new RegExp(marker));
    const response = await modelRuntime.complete({
      provider,
      model,
      messages: context.messages,
      systemPrompt: context.systemPrompt,
      maxOutputTokens: 1024,
      temperature: 0,
    });
    const text = response.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
    assert.match(text, new RegExp(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real agent calls a deterministic local tool and uses its result", { timeout: 180_000 }, async () => {
  externalModel();
  const workspace = await mkdtemp(path.join(tmpdir(), "pilotdeck-external-agent-"));
  const stack = createLocalGateway({
    projectRoot: workspace,
    pilotHome: process.env.PILOT_HOME,
    permissionMode: "bypassPermissions",
    extraTools: [addNumbersTool()],
  });
  try {
    const { sessionKey } = await stack.gateway.newSession({ channelKey: "test", projectKey: workspace });
    const events = [];
    for await (const event of stack.gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      projectKey: workspace,
      message: "You must call add_numbers with a=17 and b=25, then reply with the result.",
      maxTurns: 4,
    })) events.push(event);
    assert.ok(events.some(event => event.type === "tool_call_finished" && event.toolName === "add_numbers" && event.ok));
    const text = events.flatMap(event => event.type === "assistant_text_delta" ? [event.text] : []).join("");
    assert.match(text, /42/);
    assert.ok(events.some(event => event.type === "turn_completed"));
  } finally {
    stack.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real web search provider returns at least one URL", { timeout: 60_000 }, async () => {
  const provider = webSearchProvider();
  const apiKey = provider === "tavily"
    ? process.env.TAVILY_API_KEY
    : process.env.GLM_WEB_SEARCH_API_KEY || process.env.ZAI_API_KEY;
  assert.ok(apiKey, `${provider} API key is required.`);
  const tool = createWebSearchTool({ provider, apiKey });
  const cwd = process.cwd();
  const result = await tool.execute({ query: "PilotDeck GitHub", gl: "us" }, {
    sessionId: "external-web-search",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false }),
  });
  const output = result.data as WebSearchOutput;
  assert.ok(output.organic.length > 0);
  assert.ok(output.organic.some(item => item.link?.startsWith("http")));
});

function addNumbersTool(): PilotDeckToolDefinition<{ a: number; b: number }, { sum: number }> {
  return {
    name: "add_numbers",
    description: "Add two numbers. Always use this tool for the external arithmetic test.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["a", "b"],
      additionalProperties: false,
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => false,
    execute: async input => ({
      content: [{ type: "text", text: String(input.a + input.b) }],
      data: { sum: input.a + input.b },
    }),
  };
}

function webSearchProvider(): WebSearchProvider {
  if (process.env.TAVILY_API_KEY?.trim()) return "tavily";
  return "glm";
}
