import assert from "node:assert/strict";
import test from "node:test";

import { FailureGuard } from "../../../src/agent/policy/FailureGuard.js";
import { resolveToolUnit, toolLabel } from "../../../src/agent/policy/classify.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { PilotFailureGuardConfig } from "../../../src/pilot/config/types.js";
import type { PilotDeckToolErrorCode } from "../../../src/tool/protocol/errors.js";
import type { PilotDeckToolResult } from "../../../src/tool/protocol/result.js";

function config(overrides: Partial<PilotFailureGuardConfig> = {}): PilotFailureGuardConfig {
  return {
    enabled: true,
    modelFailureLimit: 0,
    toolFailureLimits: {},
    toolLabels: {},
    ...overrides,
  };
}

function failure(toolName: string, code: PilotDeckToolErrorCode): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: `call-${toolName}`,
    toolName,
    error: { code, message: "failed" },
    content: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

test("exact tool names win over the longest matching MCP prefix", () => {
  const limits = { mcp__: 9, mcp__research__: 3, mcp__research__search: 1 };
  assert.deepEqual(resolveToolUnit("mcp__research__search", limits), {
    unit: "mcp__research__search",
    limit: 1,
  });
  assert.deepEqual(resolveToolUnit("mcp__research__case", limits), {
    unit: "mcp__research__",
    limit: 3,
  });
});

test("only service failure codes count", () => {
  const guard = new FailureGuard(config({ toolFailureLimits: { web_fetch: 3 } }));
  for (const code of ["invalid_tool_input", "permission_denied", "tool_timeout"] as const) {
    assert.equal(guard.onToolFinished("web_fetch", false, code), undefined);
  }
  assert.equal(guard.onToolFinished("web_fetch", false, "tool_execution_failed"), undefined);
  assert.equal(guard.onToolFinished("web_fetch", false, "tool_unavailable"), undefined);
  assert.deepEqual(guard.onToolFinished("web_fetch", false, "setup_required"), {
    kind: "tool",
    unit: "web_fetch",
    label: "web_fetch",
    failures: 3,
    limit: 3,
  });
});

test("main and subagent tool failures share one per-turn counter", () => {
  const guard = new FailureGuard(config({ toolFailureLimits: { mcp__research__: 2 } }));
  const main: AgentEvent = {
    type: "tool_result",
    sessionId: "s",
    turnId: "t",
    result: failure("mcp__research__law", "tool_execution_failed"),
  };
  const child: AgentEvent = {
    type: "subagent_tool_result",
    sessionId: "s",
    turnId: "t",
    subagentId: "sub",
    subagentType: "general",
    result: failure("mcp__research__case", "tool_unavailable"),
  };
  assert.equal(guard.observe(main), undefined);
  assert.equal(guard.observe(child)?.kind, "tool");

  const nextTurn = new FailureGuard(config({ toolFailureLimits: { mcp__research__: 2 } }));
  assert.equal(nextTurn.observe(main), undefined);
  assert.equal(nextTurn.isTripped, false);
});

test("router retries and model_error continuations share the model limit", () => {
  const guard = new FailureGuard(config({ modelFailureLimit: 2 }));
  assert.equal(guard.onModelFailure(), undefined);
  assert.deepEqual(guard.observe({
    type: "turn_continued",
    sessionId: "s",
    turnId: "t",
    reason: "model_error",
  }), { kind: "model", failures: 2, limit: 2 });
});

test("tool labels use caller configuration and otherwise preserve the tool identity", () => {
  assert.equal(toolLabel("mcp__research__"), "mcp__research__");
  assert.equal(toolLabel("mcp__research__", { mcp__research__: "Research service" }), "Research service");
  assert.equal(toolLabel("mcp__other__", { mcp__research__: "Research service" }), "mcp__other__");
});
