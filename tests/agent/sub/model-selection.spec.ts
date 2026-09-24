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
import type { SubagentModel } from "../../../src/agent/sub/subagentModels.js";
import {
  resolveSubagentProfiles,
  type SubagentProfileConfig,
} from "../../../src/agent/sub/subagentProfiles.js";

const vision: SubagentModel = {
  id: "gateway/vendor/vision", provider: "gateway", model: "vendor/vision",
  description: "Visual review; input: text, image",
  modelMultimodal: { input: ["text", "image"] as ("text" | "image")[] },
  maxContextTokens: 16000, maxOutputTokens: 4000,
};

const PROFILES: Record<string, SubagentProfileConfig> = {
  vision: {
    description: "Vision reviewer.",
    model: "gateway/vendor/vision",
    tools: ["read_file"],
    readOnly: true,
  },
  explore: { description: "Disabled explore.", enabled: false },
};

const REPORT = "Scope: file\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none";

type DelegationArgs = {
  profiles?: Record<string, SubagentProfileConfig>;
  subagentType?: string;
  extraInput?: Record<string, unknown>;
  runMode?: "agent" | "ask";
  maxSubagentDepth?: number;
  subagentModel?: AgentRuntimeConfig["subagentModel"];
  models?: SubagentModel[];
  /** Make the first child dispatch another nested subagent. */
  childDispatch?: boolean;
};

async function runDelegation(args: DelegationArgs = {}) {
  const {
    profiles,
    subagentType = "vision",
    extraInput = {},
    runMode = "agent",
    maxSubagentDepth = 1,
    subagentModel,
    models = [vision],
    childDispatch = false,
  } = args;
  const requests: CanonicalModelRequest[] = [];
  const decideCalls: Array<{ provider: string; model: string }> = [];
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
    ...(subagentModel ? { subagentModel } : {}),
    ...(profiles !== undefined ? { subagentProfiles: resolveSubagentProfiles(profiles) } : {}),
    maxSubagentDepth,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(), mode: "bypassPermissions", canPrompt: false, bypassAvailable: true,
    }),
  };
  let parentTurns = 0;
  const childTurns = new Map<string, number>();
  const childIdsSeen: string[] = [];
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry, scheduler }, eventEmitter: event => { events.push(event); },
    getSubagentModels: () => models,
    getModelTokenLimits: (provider) => provider === "gateway"
      ? { maxContextTokens: 16000, maxOutputTokens: 4000 } : undefined,
    router: {
      decide: async ({ request }) => {
        decideCalls.push({ provider: request.provider, model: request.model });
        return { provider: request.provider, model: request.model, scenarioType: "default",
          isSubagent: Boolean(request.metadata?.subagentId), orchestrating: false,
          resolvedFrom: "fallback", mutations: {} };
      },
      execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        const childId = typeof request.metadata?.subagentId === "string"
          ? request.metadata.subagentId
          : undefined;
        if (!childId) {
          if (parentTurns++ === 0) {
            yield { type: "tool_call_end", toolCall: {
              id: "delegate", name: "agent", input: {
                description: "Inspect file", prompt: "Read the file and report.",
                ...(subagentType ? { subagent_type: subagentType } : {}),
                ...extraInput,
              },
            } };
          } else {
            yield { type: "text_delta", text: REPORT };
          }
        } else {
          const turn = childTurns.get(childId) ?? 0;
          childTurns.set(childId, turn + 1);
          if (!childIdsSeen.includes(childId)) childIdsSeen.push(childId);
          const isNestedChild = childDispatch && childIdsSeen.length === 1;
          if (turn === 0 && isNestedChild) {
            yield { type: "tool_call_end", toolCall: {
              id: "nested", name: "agent",
              input: { description: "Nested look", prompt: "Look deeper.", subagent_type: "explore" },
            } };
          } else if (turn === 0) {
            yield { type: "tool_call_end", toolCall: { id: "read", name: "read_file", input: {} } };
          } else {
            yield { type: "text_delta", text: REPORT };
          }
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
  return { requests, decideCalls, events, childContexts, config, result };
}

function agentToolRequest(run: Awaited<ReturnType<typeof runDelegation>>): CanonicalModelRequest {
  const request = run.requests.find((candidate) =>
    !candidate.metadata?.subagentId && candidate.tools?.some((tool) => tool.name === "agent"));
  assert.ok(request, "parent request must carry the agent tool");
  return request;
}

function firstToolError(run: Awaited<ReturnType<typeof runDelegation>>): string {
  const event = run.events.find(event => event.type === "tool_result" && event.result.type === "error");
  assert.ok(event?.type === "tool_result" && event.result.type === "error");
  return event.result.error.message;
}

test("profile catalog replaces model guidance on the parent agent tool", async () => {
  const run = await runDelegation({ profiles: PROFILES });
  const parent = agentToolRequest(run);
  const agent = parent.tools?.find((tool) => tool.name === "agent");
  assert.match(agent?.description ?? "", /- vision: Vision reviewer\./);
  assert.match(agent?.description ?? "", /- general-purpose: /);
  assert.doesNotMatch(agent?.description ?? "", /- explore:/);
  assert.doesNotMatch(agent?.description ?? "", /Available subagent models/);
  assert.doesNotMatch(agent?.description ?? "", /gateway\/vendor\/vision/);
  const properties = (agent?.inputSchema.properties ?? {}) as Record<string, unknown>;
  assert.ok(!("model" in properties));

  const children = run.requests.filter((request) => request.metadata?.subagentId);
  assert.equal(children.length, 2);
  for (const request of children) {
    assert.equal(request.provider, vision.provider);
    assert.equal(request.model, vision.model);
    assert.equal(request.maxOutputTokens, 4000);
    assert.ok(!request.tools?.some((tool) => tool.name === "agent"));
  }
  assert.deepEqual(run.childContexts[0]?.modelMultimodal, vision.modelMultimodal);
  assert.equal(run.childContexts[0]?.runMode, "ask");
  assert.equal(run.config.model, "parent");
});

test("unbound profile keeps configured default subagent routing", async () => {
  const run = await runDelegation({
    profiles: { researcher: { description: "Researcher." } },
    subagentType: "researcher",
    subagentModel: { provider: "default", model: "child", maxContextTokens: 5000, maxOutputTokens: 1000 },
  });
  const children = run.requests.filter((request) => request.metadata?.subagentId);
  assert.equal(children.length, 2);
  assert.ok(children.every((request) => request.provider === "default" && request.model === "child"));
  assert.ok(run.decideCalls.filter((call) => call.model === "child").length >= 2);
});

test("disabled profile is rejected before any child starts", async () => {
  const run = await runDelegation({ profiles: PROFILES, subagentType: "explore" });
  assert.equal(run.requests.filter((request) => request.metadata?.subagentId).length, 0);
  assert.ok(!run.events.some((event) => event.type === "subagent_started"));
  const text = firstToolError(run);
  assert.match(text, /Unknown subagent_type "explore"/);
  assert.match(text, /vision/);
});

test("unavailable bound model fails visibly before any child starts", async () => {
  const run = await runDelegation({ profiles: PROFILES, models: [] });
  assert.equal(run.requests.filter((request) => request.metadata?.subagentId).length, 0);
  assert.ok(!run.events.some((event) => event.type === "subagent_started"));
  const text = JSON.stringify(run.result.messages);
  assert.match(text, /gateway\/vendor\/vision/);
  assert.match(text, /vision/);
});

test("ask mode exposes only read-only profiles and remaps general-purpose", async () => {
  const profiles: Record<string, SubagentProfileConfig> = {
    writer: { description: "Writable writer.", readOnly: false },
    vision: { description: "Vision reviewer.", model: "gateway/vendor/vision" },
  };
  const catalogRun = await runDelegation({
    profiles, subagentType: "vision", runMode: "ask",
  });
  const parent = agentToolRequest(catalogRun);
  const agent = parent.tools?.find((tool) => tool.name === "agent");
  assert.match(agent?.description ?? "", /- vision: Vision reviewer\./);
  assert.doesNotMatch(agent?.description ?? "", /writer/);
  assert.doesNotMatch(agent?.description ?? "", /general-purpose/);

  const remapped = await runDelegation({
    profiles, subagentType: "general-purpose", runMode: "ask",
  });
  const children = remapped.requests.filter((request) => request.metadata?.subagentId);
  assert.ok(children.length >= 1);
  assert.equal(remapped.childContexts[0]?.runMode, "ask");
  assert.ok(remapped.events.some((event) =>
    event.type === "subagent_started" && event.subagentType === "explore"));

  const writerRun = await runDelegation({
    profiles, subagentType: "writer", runMode: "ask",
  });
  assert.equal(writerRun.requests.filter((request) => request.metadata?.subagentId).length, 0);
  assert.match(firstToolError(writerRun), /Unknown subagent_type "writer"/);
});

test("nested dispatch works at depth 2 and is hidden at depth 1", async () => {
  for (const maxSubagentDepth of [2, 1] as const) {
    const run = await runDelegation({
      profiles: { "general-purpose": { description: "General." } },
      subagentType: "general-purpose",
      maxSubagentDepth,
      models: [],
      childDispatch: true,
    });
    const childRequests = run.requests.filter((request) => request.metadata?.subagentId);
    const startedEvents = run.events.filter((event) => event.type === "subagent_started");
    if (maxSubagentDepth === 2) {
      assert.equal(startedEvents.length, 2, "child and grandchild must both start");
      const subagentIds = new Set(startedEvents.map((event) =>
        event.type === "subagent_started" ? event.subagentId : ""));
      assert.equal(subagentIds.size, 2, "nested events must carry distinct subagent ids");
      assert.ok(run.events.filter((event) => event.type === "subagent_completed").length >= 2);
      const childRequest = childRequests[0];
      assert.ok(childRequest?.tools?.some((tool) => tool.name === "agent"),
        "child below the cap keeps a visible nested agent tool");
      const grandchild = childRequests.slice(1).find((request) =>
        typeof request.metadata?.subagentId === "string" &&
        request.metadata.subagentId !== childRequests[0]?.metadata?.subagentId);
      assert.ok(grandchild, "grandchild loop must issue its own model requests");
    } else {
      assert.equal(startedEvents.length, 1);
      assert.ok(childRequests.length >= 1);
      assert.ok(childRequests.every((request) =>
        !request.tools?.some((tool) => tool.name === "agent")),
        "child at the cap must not see the nested agent tool");
    }
  }
});

test("maxDepth 0 refuses even top-level dispatch at runtime", async () => {
  const run = await runDelegation({
    profiles: { vision: { description: "Vision reviewer." } },
    subagentType: "vision",
    maxSubagentDepth: 0,
    models: [],
  });
  assert.equal(run.requests.filter((request) => request.metadata?.subagentId).length, 0);
  assert.ok(!run.events.some((event) => event.type === "subagent_started"));
  const text = JSON.stringify(run.result.messages);
  assert.match(text, /subagent_depth_exceeded/);
});
