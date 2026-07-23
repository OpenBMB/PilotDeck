import assert from "node:assert/strict";
import test from "node:test";

import { LargeFileRepair } from "../../../src/agent/loop/LargeFileRepair.js";
import type { PilotDeckToolResult } from "../../../src/tool/index.js";

const NO_TRUNCATION = {
  outputTruncated: false,
  repairedToolCalls: false,
  finishReason: "tool_call",
};

function success(toolName: string, data?: unknown): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: `call-${toolName}`,
    toolName,
    content: [],
    data,
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.001Z",
  };
}

function failure(
  toolName: string,
  message: string,
  options: {
    code?: "invalid_tool_input" | "result_too_large" | "permission_denied" | "permission_cancelled";
    details?: Record<string, unknown>;
  } = {},
): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: `call-${toolName}`,
    toolName,
    error: {
      code: options.code ?? "invalid_tool_input",
      message,
      details: options.details,
    },
    content: [],
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.001Z",
  };
}

test("ordinary edit failures after a successful write do not enter large-file repair", () => {
  const repair = new LargeFileRepair();

  assert.equal(
    repair.analyzeToolResults(
      [success("write_file", { filePath: "/workspace/report.xlsx" })],
      NO_TRUNCATION,
    ),
    undefined,
  );

  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(
      repair.analyzeToolResults(
        [failure("edit_file", "String to replace not found in file.")],
        NO_TRUNCATION,
      ),
      undefined,
    );
  }

  assert.equal(repair.hasPendingRepair, false);
});

test("an explicit post-draft large-file failure starts bounded recovery", () => {
  const repair = new LargeFileRepair();
  repair.analyzeToolResults(
    [success("write_file", { filePath: "/workspace/report.xlsx" })],
    NO_TRUNCATION,
  );

  for (let attempt = 1; attempt <= 5; attempt++) {
    const decision = repair.analyzeToolResults(
      [failure("edit_file", "Tool output was truncated.", { code: "result_too_large" })],
      NO_TRUNCATION,
    );
    assert.equal(decision?.type, "continue");
    assert.match(decision?.type === "continue" ? decision.prompt : "", new RegExp(`${attempt}/5`));
  }

  const stopped = repair.analyzeToolResults(
    [failure("edit_file", "Tool output was truncated.", { code: "result_too_large" })],
    NO_TRUNCATION,
  );
  assert.equal(stopped?.type, "stop");
  assert.match(stopped?.type === "stop" ? stopped.reason : "", /after 5 post-draft attempts/);
});

test("successful focused write clears an active large-file repair episode", () => {
  const repair = new LargeFileRepair();

  const started = repair.analyzeToolResults(
    [failure("write_file", "The required parameter `content` is missing", {
      details: { issues: [{ path: "$.content", code: "required" }] },
    })],
    NO_TRUNCATION,
  );
  assert.equal(started?.type, "continue");
  assert.equal(repair.hasPendingRepair, true);

  const completed = repair.analyzeToolResults(
    [
      success("write_file", { filePath: "/workspace/report.xlsx" }),
      failure("bash", "verification command failed"),
    ],
    NO_TRUNCATION,
  );
  assert.equal(completed, undefined);
  assert.equal(repair.hasPendingRepair, false);
});

test("permission failures are never reclassified as large-file recovery", () => {
  const repair = new LargeFileRepair();
  repair.analyzeToolResults(
    [success("write_file", { filePath: "/workspace/report.xlsx" })],
    NO_TRUNCATION,
  );

  assert.equal(
    repair.analyzeToolResults(
      [failure("edit_file", "Permission denied", { code: "permission_denied" })],
      { ...NO_TRUNCATION, outputTruncated: true },
    ),
    undefined,
  );
  assert.equal(
    repair.analyzeToolResults(
      [failure("edit_file", "Permission request cancelled", { code: "permission_cancelled" })],
      { ...NO_TRUNCATION, outputTruncated: true },
    ),
    undefined,
  );
});
