import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolRegistry,
  createAgentTool,
  createAskUserQuestionTool,
  createEnterPlanModeTool,
  createToolCapabilityPolicy,
  type PilotDeckToolDefinition,
} from "../../../src/tool/index.js";

function createTool(
  name: string,
  requiredRuntimeCapabilities?: PilotDeckToolDefinition["requiredRuntimeCapabilities"],
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    requiredRuntimeCapabilities,
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], data: {} }),
  };
}

test("scoped tool views delegate to the parent registry without copying definitions", () => {
  const parent = new ToolRegistry();
  const view = parent.createScopedView(createToolCapabilityPolicy({ allowedTools: ["*"] }));
  const initial = createTool("dynamic");
  initial.aliases = ["DynamicAlias"];

  parent.register(initial);
  assert.equal(view.get("dynamic"), initial);

  const replacement = { ...initial, description: "replacement" };
  parent.replace(replacement);
  assert.equal(view.get("dynamic"), replacement);
  assert.equal(view.get("DynamicAlias"), replacement);

  parent.unregister("dynamic");
  assert.equal(view.has("dynamic"), false);
});

test("agent description reflects the effective nested delegation cap", () => {
  const defaultAgent = createAgentTool({ maxSubagentDepth: 1 });
  const nestedAgent = createAgentTool({ maxSubagentDepth: 2 });

  assert.match(defaultAgent.description, /except nested agent launch/);
  assert.doesNotMatch(defaultAgent.description, /nested delegation is available/);
  assert.match(nestedAgent.description, /nested delegation is available within the configured depth cap/);
});

test("session agent description shadowing does not mutate the project registry", () => {
  const project = new ToolRegistry();
  project.register(createAgentTool({ maxSubagentDepth: 1 }));
  const session = project.clone();
  session.replace(createAgentTool({ maxSubagentDepth: 2 }));

  assert.match(project.get("agent")?.description ?? "", /except nested agent launch/);
  assert.match(session.get("agent")?.description ?? "", /nested delegation is available within the configured depth cap/);
  session.dispose();
});

test("tool registrations are exact handles and owned views dispose without affecting the parent", () => {
  const parent = new ToolRegistry();
  const initial = createTool("replaceable");
  const registration = parent.register(initial);
  assert.equal(registration.name, "replaceable");
  assert.equal(registration.active, true);

  const replacement = { ...initial, description: "replacement" };
  const replacementRegistration = parent.replace(replacement);
  assert.equal(registration.active, false);
  assert.equal(replacementRegistration.active, true);
  registration.dispose();
  assert.equal(parent.get("replaceable"), replacement);

  const view = parent.createScopedView(createToolCapabilityPolicy({ allowedTools: ["*"] }));
  view.register(createTool("child-only"));
  assert.equal(view.has("child-only"), true);
  view.dispose();
  assert.equal(view.state, "disposed");
  assert.equal(view.has("child-only"), false);
  assert.equal(parent.has("replaceable"), true);
  assert.throws(() => view.register(createTool("late")), /disposed/);

  replacementRegistration.dispose();
  assert.equal(parent.has("replaceable"), false);
});

test("local upsert shadows inherited tools without mutating the parent", () => {
  const parent = new ToolRegistry();
  const inherited = createTool("read_skill");
  parent.register(inherited);
  const view = parent.createScopedView(createToolCapabilityPolicy({ allowedTools: ["*"] }));
  const scoped = { ...inherited, description: "scoped skill loader" };

  view.registerOrReplace(scoped);

  assert.equal(view.get("read_skill"), scoped);
  assert.equal(parent.get("read_skill"), inherited);
});

test("subagent policy uses capability requirements instead of tool-name exclusions", () => {
  const parent = new ToolRegistry();
  parent.register(createTool("always_on_name_without_requirement"));
  parent.register(createTool("delegator", ["subagent_fork"]));
  parent.register(createTool("interactive", ["user_interaction"]));
  const policy = createToolCapabilityPolicy({ allowedTools: ["*"] });
  const view = parent.createScopedView(policy);

  assert.deepEqual(view.list().map((tool) => tool.name), ["always_on_name_without_requirement"]);
  assert.deepEqual(policy.evaluate(parent.get("delegator")!), {
    allowed: false,
    reason: "missing_runtime_capability",
    capability: "subagent_fork",
  });
});

test("built-in scoped tools declare their runtime requirements", () => {
  assert.deepEqual(createAgentTool().requiredRuntimeCapabilities, ["subagent_fork"]);
  assert.deepEqual(createEnterPlanModeTool().requiredRuntimeCapabilities, ["plan_workflow"]);
  assert.deepEqual(createAskUserQuestionTool().requiredRuntimeCapabilities, ["user_interaction"]);
});
