import assert from "node:assert/strict";
import test from "node:test";
import { ASK_MODE_ALLOWED_TOOLS, getAskModeViolation } from "../../src/tool/askModeConstraints.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../../src/tool/planModeConstraints.js";
import { isProtectedContextMessage } from "../../src/context/compaction/protectedContext.js";
import { createTaskPreviewTool } from "../../src/tool/builtin/taskPreview.js";
import type { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";

test("preview is available in read-only modes while service creation remains blocked", () => {
  const tool = createTaskPreviewTool({} as BackgroundTaskRuntime);
  assert.equal(getAskModeViolation(tool, {}), undefined);
  for (const names of [ASK_MODE_ALLOWED_TOOLS, PLAN_MODE_ALLOWED_TOOLS]) {
    assert.ok(names.has("task_preview"));
    assert.ok(!names.has("task_create"));
    assert.ok(!names.has("task_stop"));
  }
});

test("preview results and calls survive task context protection", () => {
  assert.ok(isProtectedContextMessage({ role: "assistant", content: [{ type: "tool_call", id: "preview", name: "task_preview", input: {} }] }));
  assert.ok(isProtectedContextMessage({ role: "user", content: [{ type: "tool_result", toolCallId: "preview", content: [{ type: "text", text: "preview URL and stop identity" }] }] }, { toolNamesByCallId: new Map([["preview", "task_preview"]]) }));
});
