import assert from "node:assert/strict";
import test from "node:test";
import { buildBackgroundSubagentResultMessage, MAX_BACKGROUND_REPORT_CHARS } from "../../../src/agent/loop/backgroundSubagents.js";

test("both background reports and error text are bounded before entering parent context", () => {
  for (const body of [{ report: "R".repeat(50000) }, { error: "E".repeat(50000) }]) {
    const message = buildBackgroundSubagentResultMessage({ taskId: "task", subagentId: "task", subagentType: "explore", status: "failed", ...body });
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("");
    assert.ok(text.length < MAX_BACKGROUND_REPORT_CHARS + 1000, "a huge error must not overflow the parent's context");
    assert.match(text, /UNTRUSTED TOOL OUTPUT/);
    assert.match(text, /task_output/);
  }
});
