import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { CanonicalModelRequest, CanonicalModelEvent } from "../../../src/model/index.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry, type PilotDeckToolRuntimeContext } from "../../../src/tool/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";

const vision = {
  id: "gateway/vendor/vision", provider: "gateway", model: "vendor/vision",
  description: "Visual review; input: text, image",
  modelMultimodal: { input: ["text", "image"] as ("text" | "image")[] },
  maxContextTokens: 16000, maxOutputTokens: 4000,
};

async function runDelegation(model?: string, runMode: "agent" | "ask" = "agent") {
  const requests: CanonicalModelRequest[] = [];
  const decisions: string[] = [];
  const events: AgentEvent[] = [];
  const childContexts: PilotDeckToolRuntimeContext[] = [];
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  registry.register({
    name: "read_file", description: "Read a file", kind: "filesystem",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async (_args, context) => {
      childContexts.push(context);
      return { content: [{ type: "text", text: "file contents" }] };
    },
  });
  const scheduler = new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry);
  const config: AgentRuntimeConfig = {
    provider: "main", model: "parent", cwd: process.cwd(), runMode,
    modelMultimodal: { input: ["text"] }, maxContextTokens: 100000, maxOutputTokens: 8000,
    subagentModel: { provider: "default", model: "child", maxContextTokens: 5000, maxOutputTokens: 1000 },
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(), mode: "bypassPermissions", canPrompt: false, bypassAvailable: true,
    }),
  };
  let parentTurns = 0;
  let childTurns = 0;
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry, scheduler }, eventEmitter: event => { events.push(event); },
    getSubagentModels: () => [vision],
    getModelTokenLimits: (provider) => provider === "gateway"
      ? { maxContextTokens: 16000, maxOutputTokens: 4000 } : undefined,
    router: {
      decide: async ({ request }) => {
        decisions.push(request.metadata?.subagentId ? "child" : "parent");
        return { provider: request.provider, model: request.model, scenarioType: "default",
          isSubagent: Boolean(request.metadata?.subagentId), orchestrating: false,
          resolvedFrom: "fallback", mutations: {} };
      },
      execute: async function* (decision, request): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        const child = Boolean(request.metadata?.subagentId);
        if ((child ? childTurns++ : parentTurns++) === 0) {
          if (child && model) {
            assert.equal(decision.scenarioType, "explicit");
            assert.equal(decision.model, vision.model);
          }
          yield { type: "tool_call_end", toolCall: child
            ? { id: "read", name: "read_file", input: {} }
            : { id: "delegate", name: "agent", input: {
              description: "Inspect file", prompt: "Read the file and report.", subagent_type: "explore",
              ...(model !== undefined ? { model } : {}),
            } } };
        } else {
          yield { type: "text_delta", text: "Scope: file\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none" };
        }
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () { throw new Error("unexpected single-shot stream"); },
    },
  };
  const generator = new AgentLoop(config, dependencies).run({
    sessionId: "parent", turnId: "turn", maxTurns: 4,
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect the file" }] }],
  });
  let result;
  while (true) {
    const next = await generator.next();
    if (next.done) { result = next.value; break; }
    events.push(next.value);
  }
  return { requests, decisions, events, childContexts, config, result };
}

for (const mode of ["agent", "ask"] as const) {
  test(`explicit subagent model stays selected across tool turns in ${mode} mode`, async () => {
    const run = await runDelegation(vision.id, mode);
    const children = run.requests.filter(request => request.metadata?.subagentId);
    const parents = run.requests.filter(request => !request.metadata?.subagentId);
    assert.equal(children.length, 2);
    assert.deepEqual(run.decisions, ["parent", "parent"]);
    for (const request of children) {
      assert.equal(request.provider, vision.provider);
      assert.equal(request.model, vision.model);
      assert.equal(request.maxOutputTokens, 4000);
      assert.ok(!request.tools?.some(tool => tool.name === "agent"));
    }
    for (const request of parents) {
      assert.equal(request.model, "parent");
      const agent = request.tools?.find(tool => tool.name === "agent");
      assert.match(agent?.description ?? "", /gateway\/vendor\/vision/);
      assert.match(agent?.description ?? "", /Visual review/);
      assert.equal((agent?.inputSchema.properties as Record<string, { type: string }>).model.type, "string");
    }
    assert.deepEqual(run.childContexts[0]?.modelMultimodal, vision.modelMultimodal);
    assert.equal(run.childContexts[0]?.runMode, "ask");
    assert.equal(run.config.model, "parent");
    assert.equal(run.config.subagentModel?.model, "child");
  });
}

test("omitting model preserves the configured child default and routing", async () => {
  const run = await runDelegation();
  const children = run.requests.filter(request => request.metadata?.subagentId);
  assert.equal(children.length, 2);
  assert.deepEqual(run.decisions, ["parent", "child", "child", "parent"]);
  assert.ok(children.every(request => request.provider === "default" && request.model === "child"));
});

test("unknown model returns a tool error before any child starts", async () => {
  const run = await runDelegation("missing/model");
  assert.equal(run.requests.filter(request => request.metadata?.subagentId).length, 0);
  assert.ok(!run.events.some(event => event.type === "subagent_started"));
  assert.match(JSON.stringify(run.result.messages), /invalid_tool_input/);
  assert.match(JSON.stringify(run.result.messages), /gateway\/vendor\/vision/);
});
