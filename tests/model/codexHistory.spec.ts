import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexHistory } from "../../src/model/providers/codex/history.js";
import type { CanonicalMessage } from "../../src/model/protocol/canonical.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name = "run") => ({
  type: "tool_call" as const,
  id,
  name,
  input: { id },
});
const result = (id: string, value: string) => ({
  type: "tool_result" as const,
  toolCallId: id,
  content: [text(value)],
});

test("keeps exactly the first output occurring after a unique call", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [result("valid", "too early"), text("before")] },
    { role: "assistant", content: [call("valid"), text("between")] },
    {
      role: "user",
      metadata: { purpose: "fixture" },
      content: [
        result("valid", "first"),
        { type: "tool_result_reference", toolCallId: "valid", path: "/tmp/result", originalBytes: 9, preview: "duplicate", hasMore: false },
        text("after"),
      ],
    },
  ];

  assert.deepEqual(normalizeCodexHistory(messages), [
    { role: "user", content: [text("before")] },
    { role: "assistant", content: [call("valid"), text("between")] },
    {
      role: "user",
      metadata: { purpose: "fixture" },
      content: [result("valid", "first"), text("after")],
    },
  ]);
});

test("drops orphan outputs and unmatched unique calls", () => {
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [text("a"), call("unmatched")] },
    { role: "user", content: [result("orphan", "no call"), text("b")] },
  ];

  assert.deepEqual(normalizeCodexHistory(messages), [
    { role: "assistant", content: [text("a")] },
    { role: "user", content: [text("b")] },
  ]);
});

test("removes every call and output for duplicated call ids", () => {
  const messages: CanonicalMessage[] = [
    { role: "assistant", content: [call("duplicate"), text("one")] },
    { role: "user", content: [result("duplicate", "between")] },
    { role: "assistant", content: [text("two"), call("duplicate")] },
    { role: "user", content: [result("duplicate", "after"), text("three")] },
  ];

  assert.deepEqual(normalizeCodexHistory(messages), [
    { role: "assistant", content: [text("one")] },
    { role: "assistant", content: [text("two")] },
    { role: "user", content: [text("three")] },
  ]);
});

test("preserves non-tool blocks without inspecting text and does not mutate input", () => {
  const messages: CanonicalMessage[] = [{
    role: "assistant",
    metadata: { synthetic: true },
    content: [
      text("memory summary mentions tool_call ghost and tool_result ghost"),
      { type: "thinking", text: "do not parse this", signature: "sig" },
      { type: "image", source: "url", data: "https://example.test/a.png", mimeType: "image/png" },
      call("ok"),
    ],
  }, {
    role: "user",
    content: [
      result("ok", "done"),
      { type: "media_reference", path: "/tmp/media", originalBytes: 3, preview: "media", hasMore: false, mimeType: "image/png", mediaType: "image" },
    ],
  }];
  const snapshot = structuredClone(messages);

  const normalized = normalizeCodexHistory(messages);

  assert.deepEqual(normalized, messages);
  assert.deepEqual(messages, snapshot);
  assert.notEqual(normalized, messages);
  assert.notEqual(normalized[0], messages[0]);
  assert.notEqual(normalized[0].content, messages[0].content);
  assert.equal(normalized[0].content[0], messages[0].content[0]);
  assert.equal(normalized[0].metadata, messages[0].metadata);
});
