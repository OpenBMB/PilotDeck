import test from "node:test";
import assert from "node:assert/strict";

import { applyResultSizeLimit } from "../../src/tool/protocol/result.js";

test("applyResultSizeLimit keeps both head and tail when truncating text output", () => {
  const head = "HEAD: command started";
  const middle = "M".repeat(400);
  const tail = "TAIL: traceback root cause ENOENT missing config";
  const { content, metadata } = applyResultSizeLimit(
    [{ type: "text", text: `${head}\n${middle}\n${tail}` }],
    180,
  );

  assert.equal(metadata?.truncated, true);
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  const text = content[0]?.type === "text" ? content[0].text : "";
  assert.match(text, /HEAD: command started/);
  assert.match(text, /TAIL: traceback root cause ENOENT missing config/);
  assert.match(text, /middle omitted/);
  assert.match(text, /head and tail shown/);
});
