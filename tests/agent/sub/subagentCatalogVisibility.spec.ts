import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { resolveSubagentProfiles } from "../../../src/agent/sub/subagentProfiles.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";

const disabledBuiltins = Object.fromEntries(["general-purpose", "explore", "plan", "verify"].map(id => [id, { enabled: false }]));

async function agentSchema(config: Partial<AgentRuntimeConfig>) {
  let captured: CanonicalModelRequest | undefined;
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry, scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"] },
    router: {
      decide: async ({ request }) => ({ provider: request.provider, model: request.model,
        scenarioType: "default", isSubagent: false, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
      execute: async function* (_decision, request) {
        captured = request;
        yield { type: "text_delta", text: "Done" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () { throw new Error("Unexpected legacy call"); },
    },
  };
  const cwd = process.cwd();
  const generator = new AgentLoop({ provider: "test", model: "text", cwd, runMode: "agent", permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false, bypassAvailable: false }), ...config,
  }, dependencies).run({ sessionId: "parent", turnId: "t1", maxTurns: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  });
  while (!(await generator.next()).done) { /* capture the actual model request */ }
  assert.ok(captured);
  return captured.tools?.find(tool => tool.name === "agent");
}

test("the agent tool is hidden when delegation depth is zero", async () => {
  assert.equal(await agentSchema({ maxSubagentDepth: 0 }), undefined);
});

test("the agent tool is hidden when no profile can be dispatched", async () => {
  assert.equal(await agentSchema({ subagentProfiles: resolveSubagentProfiles(disabledBuiltins) }), undefined);
});

test("normal and ask-mode schemas advertise exactly the enabled custom types", async () => {
  for (const runMode of ["agent", "ask"] as const) {
    const schema = await agentSchema({ runMode, subagentProfiles: resolveSubagentProfiles({ ...disabledBuiltins,
      vision: { description: "Read visual evidence", model: "provider/secret-model-name" },
    }) });
    assert.ok(schema);
    const properties = schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.subagent_type?.enum, ["vision"]);
    assert.match(schema.description ?? "", /vision: Read visual evidence/);
    assert.doesNotMatch(JSON.stringify(schema), /secret-model-name/);
    assert.doesNotMatch(JSON.stringify(schema), /Defaults to 'explore'|only 'explore', 'plan'/);
  }
});
