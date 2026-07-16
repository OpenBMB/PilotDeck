import test from "node:test";
import assert from "node:assert/strict";

import { buildToolErrorRecovery } from "../../src/tool/execution/errorRecovery.js";
import type { PilotDeckToolValidationIssue } from "../../src/tool/protocol/schema.js";

function recovery(options: {
  toolName: string;
  message: string;
  issues?: PilotDeckToolValidationIssue[];
}) {
  return buildToolErrorRecovery({
    code: "invalid_tool_input",
    toolName: options.toolName,
    message: options.message,
    cwd: "/workspace",
    permissionMode: "bypassPermissions",
    details: options.issues ? { issues: options.issues } : undefined,
  }).message;
}

test("write_file freshness error tells the model to read the file first", () => {
  const text = recovery({
    toolName: "write_file",
    message: "write_file failed due to the following issue:\nFile has not been read yet. Read it first before writing to it.",
    issues: [{
      path: "file_path",
      code: "invalid_schema",
      message: "File has not been read yet. Read it first before writing to it.",
    }],
  });

  assert.match(text, /Summary: File has not been read yet\. Read it first before writing to it\./);
  assert.match(text, /Evidence:\n- file_path: File has not been read yet/);
  assert.match(text, /Original error:\nwrite_file failed due to the following issue:/);
  assert.match(text, /Call read_file with the same file_path/);
  assert.doesNotMatch(text, /did not match the tool schema/i);
  assert.doesNotMatch(text, /smaller valid chunk/i);
});

test("write_file missing content points at the missing field and chunked recovery", () => {
  const text = recovery({
    toolName: "write_file",
    message: "write_file failed due to the following issue:\nThe required parameter `content` is missing",
    issues: [{ path: "$.content", code: "required", message: "The required parameter `content` is missing" }],
  });

  assert.match(text, /Summary: The required parameter `content` is missing/);
  assert.match(text, /Include the required parameter `content`/);
  assert.match(text, /smaller but complete draft/i);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});

test("invalid tool input keeps a bounded original error block", () => {
  const longDetail = "x".repeat(2_400);
  const text = recovery({
    toolName: "bash",
    message: `Foreground bash timeout 900000ms exceeds the maximum of 600000ms.\n${longDetail}`,
  });

  assert.match(text, /Original error:\nForeground bash timeout 900000ms exceeds the maximum of 600000ms\./);
  assert.match(text, /original error truncated; \d+ chars total/);
  assert.match(text, /Next actions:/);
});

test("edit_file old_string miss tells the model to reread and copy exact text", () => {
  const text = recovery({
    toolName: "edit_file",
    message: "String to replace not found in file.\nString: old text",
  });

  assert.match(text, /Summary: String to replace not found in file\./);
  assert.match(text, /Call read_file with the same file_path/);
  assert.match(text, /exact current text/i);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});

test("read_file invalid range preserves the concrete issue", () => {
  const text = recovery({
    toolName: "read_file",
    message: "read_file failed due to the following issue:\noffset must be a 1-based line number (>= 1).",
    issues: [{ path: "offset", code: "invalid_schema", message: "offset must be a 1-based line number (>= 1)." }],
  });

  assert.match(text, /Summary: offset must be a 1-based line number/);
  assert.match(text, /Fix `offset`: offset must be a 1-based line number/);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});

test("bash missing command reports the required command parameter", () => {
  const text = recovery({
    toolName: "bash",
    message: "bash failed due to the following issue:\nThe required parameter `command` is missing",
    issues: [{ path: "$.command", code: "required", message: "The required parameter `command` is missing" }],
  });

  assert.match(text, /Summary: The required parameter `command` is missing/);
  assert.match(text, /Include the required parameter `command`/);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});

test("bash timeout over max keeps foreground and task_wait guidance", () => {
  const text = recovery({
    toolName: "bash",
    message: "Foreground bash timeout 900000ms exceeds the maximum of 600000ms. Use timeout=600000 or less for foreground bash. If the command must run in the background, use task_create and then task_wait to block for completion; use task_output only for progress checks and task_stop to clean up long-lived processes.",
  });

  assert.match(text, /Summary: Foreground bash timeout 900000ms exceeds the maximum of 600000ms/);
  assert.match(text, /Use timeout=600000 or less for foreground bash/);
  assert.match(text, /task_create and then task_wait/);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});

test("bash background rejection keeps background-specific guidance", () => {
  const text = recovery({
    toolName: "bash",
    message: "This command appears to start background work. Use timeout=600000 or less for foreground bash. If the command must run in the background, use task_create and then task_wait to block for completion; use task_output only for progress checks and task_stop to clean up long-lived processes.",
  });

  assert.match(text, /Summary: This command appears to start background work/);
  assert.match(text, /Run short commands directly in foreground bash/);
  assert.match(text, /task_create and then task_wait/);
  assert.doesNotMatch(text, /did not match the tool schema/i);
});
