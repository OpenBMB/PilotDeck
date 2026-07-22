import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecuteCodeTool,
  handleExecuteCodeRpcLineForTests,
} from "../../../src/tool/builtin/executeCode.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

test("execute_code read-only probe handles missing input", () => {
  const tool = createExecuteCodeTool();

  assert.equal(tool.isReadOnly({} as never), false);
});

test("disabling web search removes it from the registry but keeps web fetch", () => {
  const registry = createBuiltinRegistry({ webSearch: false });

  assert.equal(registry.has("web_search"), false);
  assert.equal(registry.has("WebSearch"), false);
  assert.equal(registry.has("web_fetch"), true);
  assert.doesNotMatch(registry.get("execute_code")?.description ?? "", /\bweb_search\b/);
  assert.match(registry.get("execute_code")?.description ?? "", /\bweb_fetch\b/);
});

test("execute_code rejects nested web search calls when web search is disabled", async () => {
  let executed = false;
  const response = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "web_search", args: { query: "hello" } }),
    {
      webSearch: false,
      executeTool: async () => {
        executed = true;
        throw new Error("web_search should not be invoked");
      },
    },
  );

  assert.equal(response.code, "tool_not_allowed");
  assert.equal(executed, false);
});
