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

test("applyResultSizeLimit never returns more bytes than a small maxBytes cap", () => {
  const suffixBytes = Buffer.byteLength("\n[Tool output truncated: head and tail shown.]", "utf8");
  const original = "x".repeat(500);

  for (const maxBytes of [0, 1, suffixBytes - 1, suffixBytes, suffixBytes + 1]) {
    const { content, metadata } = applyResultSizeLimit([{ type: "text", text: original }], maxBytes);
    const text = content[0]?.type === "text" ? content[0].text : "";
    const returnedBytes = Buffer.byteLength(text, "utf8");

    assert.ok(returnedBytes <= maxBytes, `maxBytes=${maxBytes}: returned ${returnedBytes} bytes`);
    assert.equal(metadata?.truncated, true);
    assert.equal(metadata?.originalBytes, 500);
    assert.equal(metadata?.returnedBytes, returnedBytes);
  }
});

test("applyResultSizeLimit stays UTF-8 safe and within the cap at a byte boundary", () => {
  const original = "€".repeat(300); // 3 bytes per character
  const maxBytes = 121;
  const { content, metadata } = applyResultSizeLimit([{ type: "text", text: original }], maxBytes);
  const text = content[0]?.type === "text" ? content[0].text : "";
  const returnedBytes = Buffer.byteLength(text, "utf8");

  assert.ok(returnedBytes <= maxBytes, `returned ${returnedBytes} bytes`);
  assert.equal(metadata?.returnedBytes, returnedBytes);
  assert.ok(!text.includes("�"), "output must not contain replacement characters");
});
