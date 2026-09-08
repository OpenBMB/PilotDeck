import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCachePlan,
  selectRecentMessageBreakpoints,
} from "../../src/context/cache/CachePlan.js";
import type { CanonicalMessage, CanonicalToolSchema } from "../../src/model/index.js";

const textMessage = (role: "user" | "assistant", text: string): CanonicalMessage => ({
  role,
  content: [{ type: "text", text }],
});

const tool: CanonicalToolSchema = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

test("selectRecentMessageBreakpoints chooses the final three non-system positions", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "system" }] },
    textMessage("user", "one"),
    textMessage("assistant", "two"),
    textMessage("user", "three"),
    textMessage("assistant", "four"),
    textMessage("user", "five"),
  ] as unknown as CanonicalMessage[];

  assert.deepEqual(selectRecentMessageBreakpoints(messages), [3, 4, 5]);
});

test("cache plan selects all messages when fewer than three are available", () => {
  const plan = buildCachePlan({
    provider: "modelbest",
    model: "claude-test",
    systemPrompt: "system",
    tools: [],
    messages: [textMessage("user", "one"), textMessage("assistant", "two")],
    enabled: true,
  }, 4);

  assert.deepEqual(plan?.messages, [0, 1]);
  assert.equal(plan?.system, true);
  assert.equal(plan?.tools, false);
  assert.equal(plan?.generation, 4);
});

test("cache plan selects interactive and incomplete messages by position", () => {
  const messages: CanonicalMessage[] = [
    textMessage("user", "first"),
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: { path: "a" } }] },
    { role: "user", content: [{ type: "text", text: "permission pending" }], metadata: { purpose: "permission" } },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "result" }] }] },
  ];
  assert.deepEqual(selectRecentMessageBreakpoints(messages), [1, 2, 3]);
});

test("disabled cache plans are omitted", () => {
  assert.equal(buildCachePlan({
    provider: "modelbest",
    model: "claude-test",
    systemPrompt: "system",
    tools: [],
    messages: [textMessage("user", "one")],
    enabled: false,
  }, 1), undefined);
});

test("cache fingerprint changes for every stable cache input", () => {
  const base = {
    provider: "modelbest",
    model: "claude-test",
    systemPrompt: "system",
    tools: [tool],
    messages: [textMessage("user", "one"), textMessage("assistant", "two")],
    enabled: true,
  };
  const fingerprint = buildCachePlan(base, 1)?.fingerprint;
  assert.notEqual(fingerprint, buildCachePlan({ ...base, provider: "other" }, 1)?.fingerprint);
  assert.notEqual(fingerprint, buildCachePlan({ ...base, model: "other-model" }, 1)?.fingerprint);
  assert.notEqual(fingerprint, buildCachePlan({ ...base, systemPrompt: "changed" }, 1)?.fingerprint);
  assert.notEqual(fingerprint, buildCachePlan({ ...base, tools: [{ ...tool, description: "changed" }] }, 1)?.fingerprint);
  assert.notEqual(fingerprint, buildCachePlan({ ...base, messages: [textMessage("user", "changed"), textMessage("assistant", "two")] }, 1)?.fingerprint);
});

test("cache fingerprint stays fixed-size when recent messages contain base64 media", () => {
  const media = "a".repeat(1024 * 1024);
  const plan = buildCachePlan({
    provider: "modelbest",
    model: "claude-test",
    systemPrompt: "system",
    tools: [],
    messages: [{
      role: "user",
      content: [{ type: "image", source: "base64", data: media, mimeType: "image/png", bytes: media.length }],
    }],
    enabled: true,
  }, 1);

  assert.match(plan?.fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.ok(!(plan?.fingerprint ?? "").includes(media));
});
