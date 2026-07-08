import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  detectFormatByText,
  extractTextToolCalls,
  getSelfCorrectPrompt,
} from "../../src/model/index.js";
import { repairToolName } from "../../src/model/streaming/repairToolName.js";

test("extracts supported text tool call formats", () => {
  const cases = [
    {
      name: "qwen_xml",
      text: "<function=read_file>\n<parameter=path>/tmp/a.txt</parameter>\n</function>",
    },
    {
      name: "deepseek_dsml",
      text: "<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"read_file\">\n<｜DSML｜parameter name=\"path\">/tmp/a.txt</content>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>",
    },
    {
      name: "hermes_json",
      text: "<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/a.txt\"}}</tool_call>",
    },
    {
      name: "mistral",
      text: "[TOOL_CALLS] [{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/a.txt\"}}]",
    },
    {
      name: "llama",
      text: "<|python_tag|>{\"name\":\"read_file\",\"parameters\":{\"path\":\"/tmp/a.txt\"}}",
    },
  ] as const;

  for (const item of cases) {
    const result = extractTextToolCalls(item.text);
    assert.equal(result.detectedFormat, item.name);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.name, "read_file");
    assert.equal(result.extractedFromText, true);
  }
});

test("reports partial tool calls without extracting a call", () => {
  const result = extractTextToolCalls("<function=read_file>\n<parameter=path>/tmp/a.txt");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.detectedFormat, "qwen_xml");
  assert.equal(result.parseError, true);
  assert.equal(result.partialToolCall?.format, "qwen_xml");
});

test("marks unparsed text tool calls on assembled messages", () => {
  const state = createModelMessageAssemblerState();
  state.content.push({ type: "text", text: "[TOOL_CALLS] not-json" });
  const assembled = assembleAssistantMessage(state);
  assert.equal(assembled.toolCalls.length, 0);
  assert.equal(assembled.hasUnparsedTextToolCall, true);
  assert.equal(assembled.textToolCallFormat, "mistral");
});

test("builds format-aware self-correction prompts", () => {
  const prompt = getSelfCorrectPrompt("qwen_xml", "<function=read_file>");
  assert.match(prompt, /Qwen XML/);
  assert.match(prompt, /<function=read_file>/);
});

test("detects tool call format by marker", () => {
  assert.equal(detectFormatByText("[TOOL_CALLS] []")?.id, "mistral");
});

test("repairs safe tool name variants", () => {
  const valid = ["read_file", "write_file", "bash"];
  assert.deepEqual(repairToolName("cat", valid, { cat: "read_file" }), {
    name: "read_file",
    reason: "alias",
  });
  assert.deepEqual(repairToolName("READ_FILE", valid), {
    name: "read_file",
    reason: "case_insensitive",
  });
  assert.deepEqual(repairToolName("read-file", valid), {
    name: "read_file",
    reason: "normalized",
  });
  assert.deepEqual(repairToolName("read_fiel", valid), {
    name: "read_file",
    reason: "edit_distance",
  });
});

test("does not repair low-confidence tool names", () => {
  assert.equal(repairToolName("run", ["bash", "read_file"]), undefined);
  assert.equal(repairToolName("unknown_tool", ["bash", "read_file"]), undefined);
});
