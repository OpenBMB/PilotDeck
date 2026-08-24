import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelResponse, CanonicalModelRequest } from "../../src/model/index.js";
import {
  createSessionTitleGenerator,
  normalizeSessionTitleInput,
  resolveSystemLanguage,
  SESSION_TITLE_MAX_INPUT_CHARS,
} from "../../src/session/title/SessionTitleGenerator.js";

test("session title generator asks the model to preserve the user's language", async () => {
  let request: CanonicalModelRequest | undefined;
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete(input) {
        request = input;
        return textResponse(JSON.stringify({ title: "修复登录流程" }));
      },
    },
    systemLanguage: "en-US",
  });

  const title = await generator({
    text: "请修复登录流程。",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "修复登录流程");
  assert.match(request?.systemPrompt ?? "", /same natural language as the user's input/);
  assert.match(request?.systemPrompt ?? "", /Do not translate.*English/);
  assert.match(request?.systemPrompt ?? "", /System language: en-US/);
});

test("session title generator includes the system language for undetectable input", async () => {
  let request: CanonicalModelRequest | undefined;
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete(input) {
        request = input;
        return textResponse(JSON.stringify({ title: "Fix login flow" }));
      },
    },
    systemLanguage: "zh-CN",
  });

  await generator({
    text: "12345",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.match(request?.systemPrompt ?? "", /System language: zh-CN/);
});

test("session title input truncation preserves the latest request", () => {
  const latestRequest = "请修复最后出现的登录错误";
  const input = `${"Earlier English logs ".repeat(100)} ${latestRequest}`;
  const normalized = normalizeSessionTitleInput(input);

  assert.ok(normalized);
  assert.equal(normalized.length, SESSION_TITLE_MAX_INPUT_CHARS);
  assert.match(normalized, /Earlier English logs/);
  assert.match(normalized, new RegExp(`${latestRequest}$`));
});

test("system language checks every locale candidate and rejects und", () => {
  assert.equal(
    resolveSystemLanguage({ LC_ALL: "", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" }),
    "zh-CN",
  );
  assert.equal(
    resolveSystemLanguage({ LC_ALL: "und", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" }),
    "zh-CN",
  );
});

function textResponse(text: string): CanonicalModelResponse {
  return { content: [{ type: "text", text }] } as CanonicalModelResponse;
}
