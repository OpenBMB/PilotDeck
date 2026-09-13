import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MCP_TOOL_DESCRIPTION_LENGTH,
  truncateMcpToolDescription,
} from "../../src/mcp/runtime/truncate.js";

test("truncateMcpToolDescription leaves descriptions at the limit unchanged", () => {
  const atLimit = "x".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH);
  assert.equal(truncateMcpToolDescription(atLimit), atLimit);
});

test("truncateMcpToolDescription keeps one-over-limit output within the cap", () => {
  const overLimit = "x".repeat(MAX_MCP_TOOL_DESCRIPTION_LENGTH + 1);
  const result = truncateMcpToolDescription(overLimit);

  assert.ok(
    result.length <= MAX_MCP_TOOL_DESCRIPTION_LENGTH,
    `expected <= ${MAX_MCP_TOOL_DESCRIPTION_LENGTH}, got ${result.length}`,
  );
  assert.equal(result.length, MAX_MCP_TOOL_DESCRIPTION_LENGTH);
  assert.ok(result.endsWith("… [truncated]"));
});

test("truncateMcpToolDescription clamps very large descriptions to the limit", () => {
  const huge = "x".repeat(30_000);
  const result = truncateMcpToolDescription(huge);

  assert.equal(result.length, MAX_MCP_TOOL_DESCRIPTION_LENGTH);
  assert.ok(result.endsWith("… [truncated]"));
});
