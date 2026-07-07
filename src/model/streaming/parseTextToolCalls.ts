import { randomUUID } from "node:crypto";
import type { CanonicalToolCall } from "../protocol/canonical.js";
import {
  detectFormatByText,
  getSelfCorrectPrompt,
  getToolCallFormats,
  registerToolCallFormat,
} from "./toolCallFormats.js";

export type TextToolCallParseResult = {
  toolCalls: CanonicalToolCall[];
  remainingText: string;
  partialToolCall?: PartialTextToolCallInfo;
  extractedFromText?: boolean;
  detectedFormat?: PartialTextToolCallFormat;
  parseError?: boolean;
};

export type PartialTextToolCallFormat =
  | "qwen_xml"
  | "deepseek_dsml"
  | "hermes_json"
  | "mistral"
  | "llama";

export type PartialTextToolCallInfo = {
  format: PartialTextToolCallFormat;
  reason: string;
  preview: string;
};

export { detectFormatByText, getSelfCorrectPrompt };

/**
 * Attempt to extract structured tool calls from assistant text content.
 *
 * When vLLM or other inference engines fail to parse model output into
 * structured `tool_calls`, the raw text ends up in the content field.
 * This function recognises the native text formats of several model
 * families and converts them into CanonicalToolCall objects.
 *
 * Tried in order: Qwen XML → DeepSeek DSML → Hermes JSON-in-XML →
 * Mistral [TOOL_CALLS] → Llama <|python_tag|>.
 */
export function extractTextToolCalls(text: string): TextToolCallParseResult {
  let firstPartial: PartialTextToolCallInfo | undefined;

  for (const format of getToolCallFormats()) {
    const markerHit = format.markers.some((marker) => text.includes(marker));
    const result = format.parse(text);
    if (result?.partialToolCall && !firstPartial) {
      firstPartial = result.partialToolCall;
    }
    if (result && result.toolCalls.length > 0) {
      return {
        ...result,
        extractedFromText: true,
        detectedFormat: format.id,
        partialToolCall: result.partialToolCall ?? firstPartial,
      };
    }
    if (markerHit && result) {
      return {
        ...result,
        detectedFormat: format.id,
        parseError: true,
        partialToolCall: result.partialToolCall ?? firstPartial,
      };
    }
  }

  const partialToolCall = firstPartial ?? detectPartialTextToolCall(text);
  return partialToolCall
    ? { toolCalls: [], remainingText: text, partialToolCall, detectedFormat: partialToolCall.format, parseError: true }
    : { toolCalls: [], remainingText: text };
}

export function hasTextToolCallSyntax(text: string): boolean {
  return detectFormatByText(text) !== undefined;
}

// ---------------------------------------------------------------------------
// Format A — Qwen3 XML
// <tool_call>
// <function=TOOL_NAME>
// <parameter=KEY>VALUE</parameter>
// </function>
// </tool_call>
//
// Variant without outer <tool_call> wrapper also accepted.
// ---------------------------------------------------------------------------

const QWEN_FUNC_RE = /<function=(\w+)>([\s\S]*?)<\/function>/g;
const QWEN_PARAM_RE = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;

function tryParseQwenXml(text: string): TextToolCallParseResult | null {
  if (!hasQwenMarker(text)) return null;

  const toolCalls: CanonicalToolCall[] = [];
  let partialToolCall: PartialTextToolCallInfo | undefined;

  for (const match of text.matchAll(QWEN_FUNC_RE)) {
    const name = match[1];
    const body = match[2];
    const input: Record<string, string> = {};

    for (const paramMatch of body.matchAll(QWEN_PARAM_RE)) {
      input[paramMatch[1]] = paramMatch[2].trim();
    }
    const parameterRemainder = body.replace(QWEN_PARAM_RE, "");
    if (!partialToolCall && hasQwenParameterMarker(parameterRemainder)) {
      partialToolCall = partialInfo(
        "qwen_xml",
        "incomplete_parameter_inside_function",
        body,
      );
    }

    toolCalls.push({
      id: generateId(),
      name,
      input,
    });
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialInfo("qwen_xml", classifyIncompleteQwenXml(text), text),
    };
  }

  let remaining = text.replace(QWEN_FUNC_RE, "");
  remaining = remaining.replace(/<\/?tool_call>/g, "");
  remaining = remaining.replace(/<\/think>/g, "");
  remaining = remaining.trim();
  partialToolCall ??= detectPartialTextToolCall(remaining, {
    preferredFormat: "qwen_xml",
    allowLooseCommandFragment: true,
  });

  return { toolCalls, remainingText: remaining, partialToolCall };
}

function classifyIncompleteQwenXml(text: string): string {
  if (/<parameter=/u.test(text) && !/<function=/u.test(text)) {
    return "orphan_qwen_parameter";
  }
  if ((/<\/parameter>/u.test(text) || /<\/function>/u.test(text)) && !/<function=/u.test(text)) {
    return "orphan_qwen_function_close";
  }
  return "qwen_xml_marker_without_complete_function";
}

// ---------------------------------------------------------------------------
// Format B — DeepSeek V4 DSML (Unicode full-width ｜ U+FF5C)
// <｜DSML｜tool_calls>
// <｜DSML｜invoke name="TOOL_NAME">
// <｜DSML｜parameter name="KEY" string="true">VALUE</content>
// </｜DSML｜invoke>
// </｜DSML｜tool_calls>
// ---------------------------------------------------------------------------

const DSML_INVOKE_RE = /<\uff5cDSML\uff5cinvoke\s+name="(\w+)">([\s\S]*?)<\/\uff5cDSML\uff5cinvoke>/g;
const DSML_PARAM_RE = /<\uff5cDSML\uff5cparameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/content>/g;

function tryParseDeepSeekDsml(text: string): TextToolCallParseResult | null {
  if (!hasDsmlMarker(text)) return null;

  const toolCalls: CanonicalToolCall[] = [];

  for (const match of text.matchAll(DSML_INVOKE_RE)) {
    const name = match[1];
    const body = match[2];
    const input: Record<string, string> = {};

    for (const paramMatch of body.matchAll(DSML_PARAM_RE)) {
      input[paramMatch[1]] = paramMatch[2].trim();
    }

    toolCalls.push({
      id: generateId(),
      name,
      input,
    });
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialInfo("deepseek_dsml", classifyIncompleteDsml(text), text),
    };
  }

  let remaining = text.replace(/<\uff5cDSML\uff5ctool_calls>[\s\S]*?<\/\uff5cDSML\uff5ctool_calls>/g, "").trim();
  const partialToolCall = detectPartialTextToolCall(remaining, {
    preferredFormat: "deepseek_dsml",
  });
  return { toolCalls, remainingText: remaining, partialToolCall };
}

function classifyIncompleteDsml(text: string): string {
  if (/<\uff5cDSML\uff5cparameter\b/u.test(text) && !/<\uff5cDSML\uff5cinvoke\b/u.test(text)) {
    return "orphan_dsml_parameter";
  }
  if ((/<\/\uff5cDSML\uff5cinvoke>/u.test(text) || /<\/\uff5cDSML\uff5ctool_calls>/u.test(text))
    && !/<\uff5cDSML\uff5cinvoke\b/u.test(text)) {
    return "orphan_dsml_tool_call_close";
  }
  return "dsml_marker_without_complete_invoke";
}

// ---------------------------------------------------------------------------
// Format C — Hermes / NousResearch JSON-in-XML
// <tool_call>
// {"name": "TOOL_NAME", "arguments": {...}}
// </tool_call>
// ---------------------------------------------------------------------------

const HERMES_OPEN = "<tool_call>";
const HERMES_CLOSE = "</tool_call>";

function tryParseHermesJson(text: string): TextToolCallParseResult | null {
  if (!hasHermesMarker(text)) return null;
  if (text.includes("<function=")) return null;

  const toolCalls: CanonicalToolCall[] = [];
  const parsedBlocks = collectHermesJsonBlocks(text);
  let partialToolCall: PartialTextToolCallInfo | undefined = parsedBlocks.partialToolCall;

  for (const block of parsedBlocks.blocks) {
    try {
      const parsed = JSON.parse(block.json);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateId(),
          name: parsed.name,
          input: parsed.arguments ?? parsed.parameters ?? {},
        });
      }
    } catch {
      partialToolCall ??= partialInfo(
        "hermes_json",
        "invalid_json_inside_tool_call",
        block.raw,
      );
    }
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialToolCall ?? partialInfo("hermes_json", classifyIncompleteHermesJson(text), text),
    };
  }

  let remaining = removeSpans(text, parsedBlocks.blocks).trim();
  partialToolCall ??= detectPartialTextToolCall(remaining, {
    preferredFormat: "hermes_json",
  });
  return { toolCalls, remainingText: remaining, partialToolCall };
}

function classifyIncompleteHermesJson(text: string): string {
  if (/<\/tool_call>/u.test(text) && !/<tool_call>/u.test(text)) {
    return "orphan_hermes_tool_call_close";
  }
  return "tool_call_marker_without_valid_json";
}

// ---------------------------------------------------------------------------
// Format D — Mistral / Devstral
// [TOOL_CALLS][{"name": "TOOL_NAME", "arguments": {...}}]
// ---------------------------------------------------------------------------

const MISTRAL_MARKER = "[TOOL_CALLS]";

function tryParseMistral(text: string): TextToolCallParseResult | null {
  if (!hasMistralMarker(text)) return null;

  const parsedBlocks = collectMistralJsonArrayBlocks(text);
  let partialToolCall: PartialTextToolCallInfo | undefined = parsedBlocks.partialToolCall;
  if (parsedBlocks.blocks.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialToolCall ?? partialInfo(
        "mistral",
        "tool_calls_marker_without_json_array",
        text,
      ),
    };
  }

  const toolCalls: CanonicalToolCall[] = [];
  for (const block of parsedBlocks.blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.json);
    } catch {
      partialToolCall ??= partialInfo("mistral", "invalid_tool_calls_json", block.raw);
      continue;
    }

    if (!Array.isArray(parsed)) {
      partialToolCall ??= partialInfo("mistral", "tool_calls_payload_not_array", block.raw);
      continue;
    }

    toolCalls.push(...parsed
      .filter((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return obj && typeof obj.name === "string";
      })
      .map((item: Record<string, unknown>) => ({
        id: generateId(),
        name: item.name as string,
        input: (item.arguments ?? item.parameters ?? {}) as unknown,
      })));
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialToolCall ?? partialInfo(
        "mistral",
        "tool_calls_array_without_names",
        parsedBlocks.blocks[0]?.raw ?? text,
      ),
    };
  }

  let remaining = removeSpans(text, parsedBlocks.blocks).trim();
  partialToolCall ??= detectPartialTextToolCall(remaining, {
    preferredFormat: "mistral",
  });
  return { toolCalls, remainingText: remaining, partialToolCall };
}

// ---------------------------------------------------------------------------
// Format E — Llama 3.x / 4.x
// <|python_tag|>{"name": "TOOL_NAME", "parameters": {...}}
// ---------------------------------------------------------------------------

const LLAMA_TAG = "<|python_tag|>";

function tryParseLlama(text: string): TextToolCallParseResult | null {
  if (!hasLlamaMarker(text)) return null;

  const toolCalls: CanonicalToolCall[] = [];
  const parsedBlocks = collectTaggedJsonObjects(text, LLAMA_TAG, "llama");
  let partialToolCall: PartialTextToolCallInfo | undefined = parsedBlocks.partialToolCall;

  for (const block of parsedBlocks.blocks) {
    try {
      const parsed = JSON.parse(block.json);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateId(),
          name: parsed.name,
          input: parsed.parameters ?? parsed.arguments ?? {},
        });
      }
    } catch {
      partialToolCall ??= partialInfo("llama", "invalid_json_after_python_tag", block.raw);
    }
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls: [],
      remainingText: text,
      partialToolCall: partialToolCall ?? partialInfo(
        "llama",
        "python_tag_without_valid_json_tool_call",
        text,
      ),
    };
  }

  let remaining = removeSpans(text, parsedBlocks.blocks).trim();
  partialToolCall ??= detectPartialTextToolCall(remaining, {
    preferredFormat: "llama",
  });
  return { toolCalls, remainingText: remaining, partialToolCall };
}

// ---------------------------------------------------------------------------

type JsonToolBlock = {
  start: number;
  end: number;
  raw: string;
  json: string;
};

function collectHermesJsonBlocks(text: string): {
  blocks: JsonToolBlock[];
  partialToolCall?: PartialTextToolCallInfo;
} {
  const blocks: JsonToolBlock[] = [];
  let partialToolCall: PartialTextToolCallInfo | undefined;
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(HERMES_OPEN, cursor);
    if (start < 0) break;

    const jsonStart = skipWhitespace(text, start + HERMES_OPEN.length);
    if (text[jsonStart] !== "{") {
      partialToolCall ??= partialInfo("hermes_json", "tool_call_marker_without_json_object", text.slice(start));
      cursor = start + HERMES_OPEN.length;
      continue;
    }

    const jsonEnd = findBalancedJsonObjectEnd(text, jsonStart);
    if (jsonEnd === undefined) {
      partialToolCall ??= partialInfo("hermes_json", "truncated_json_inside_tool_call", text.slice(start));
      break;
    }

    const closeStart = skipWhitespace(text, jsonEnd);
    if (!text.startsWith(HERMES_CLOSE, closeStart)) {
      partialToolCall ??= partialInfo("hermes_json", "missing_tool_call_close_tag", text.slice(start));
      cursor = jsonEnd;
      continue;
    }

    const end = closeStart + HERMES_CLOSE.length;
    blocks.push({
      start,
      end,
      raw: text.slice(start, end),
      json: text.slice(jsonStart, jsonEnd),
    });
    cursor = end;
  }

  return { blocks, partialToolCall };
}

function collectTaggedJsonObjects(
  text: string,
  tag: string,
  format: PartialTextToolCallFormat,
): {
  blocks: JsonToolBlock[];
  partialToolCall?: PartialTextToolCallInfo;
} {
  const blocks: JsonToolBlock[] = [];
  let partialToolCall: PartialTextToolCallInfo | undefined;
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(tag, cursor);
    if (start < 0) break;

    const jsonStart = skipWhitespace(text, start + tag.length);
    if (text[jsonStart] !== "{") {
      partialToolCall ??= partialInfo(format, "tool_marker_without_json_object", text.slice(start));
      cursor = start + tag.length;
      continue;
    }

    const jsonEnd = findBalancedJsonObjectEnd(text, jsonStart);
    if (jsonEnd === undefined) {
      partialToolCall ??= partialInfo(format, "truncated_json_after_tool_marker", text.slice(start));
      break;
    }

    blocks.push({
      start,
      end: jsonEnd,
      raw: text.slice(start, jsonEnd),
      json: text.slice(jsonStart, jsonEnd),
    });
    cursor = jsonEnd;
  }

  return { blocks, partialToolCall };
}

function collectMistralJsonArrayBlocks(text: string): {
  blocks: JsonToolBlock[];
  partialToolCall?: PartialTextToolCallInfo;
} {
  const blocks: JsonToolBlock[] = [];
  let partialToolCall: PartialTextToolCallInfo | undefined;
  let cursor = 0;

  for (;;) {
    const start = text.indexOf(MISTRAL_MARKER, cursor);
    if (start < 0) break;

    const jsonStart = skipWhitespace(text, start + MISTRAL_MARKER.length);
    if (text[jsonStart] !== "[") {
      partialToolCall ??= partialInfo("mistral", "tool_calls_marker_without_json_array", text.slice(start));
      cursor = start + MISTRAL_MARKER.length;
      continue;
    }

    const jsonEnd = findBalancedJsonArrayEnd(text, jsonStart);
    if (jsonEnd === undefined) {
      partialToolCall ??= partialInfo("mistral", "truncated_tool_calls_json_array", text.slice(start));
      break;
    }

    blocks.push({
      start,
      end: jsonEnd,
      raw: text.slice(start, jsonEnd),
      json: text.slice(jsonStart, jsonEnd),
    });
    cursor = jsonEnd;
  }

  return { blocks, partialToolCall };
}

function findBalancedJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return undefined;
}

function findBalancedJsonArrayEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth++;
      continue;
    }
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return undefined;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? "")) {
    index++;
  }
  return index;
}

function removeSpans(text: string, spans: JsonToolBlock[]): string {
  if (spans.length === 0) {
    return text;
  }
  let cursor = 0;
  let output = "";
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    output += text.slice(cursor, span.start);
    cursor = span.end;
  }
  output += text.slice(cursor);
  return output;
}

function detectPartialTextToolCall(
  text: string,
  options: {
    preferredFormat?: PartialTextToolCallFormat;
    allowLooseCommandFragment?: boolean;
  } = {},
): PartialTextToolCallInfo | undefined {
  if (text.trim().length === 0) {
    return undefined;
  }
  if (options.allowLooseCommandFragment && hasLooseToolCommandFragment(text)) {
    return partialInfo(
      options.preferredFormat ?? "qwen_xml",
      "loose_tool_command_fragment_after_tool_xml",
      text,
    );
  }
  if (options.preferredFormat && hasFormatMarker(text, options.preferredFormat)) {
    if (options.preferredFormat === "qwen_xml") {
      return partialInfo("qwen_xml", classifyIncompleteQwenXml(text), text);
    }
    if (options.preferredFormat === "hermes_json") {
      return partialInfo("hermes_json", classifyIncompleteHermesJson(text), text);
    }
    if (options.preferredFormat === "deepseek_dsml") {
      return partialInfo("deepseek_dsml", classifyIncompleteDsml(text), text);
    }
    return partialInfo(
      options.preferredFormat,
      "dangling_tool_call_fragment_after_parse",
      text,
    );
  }
  if (hasDsmlMarker(text)) {
    return partialInfo("deepseek_dsml", classifyIncompleteDsml(text), text);
  }
  if (hasHermesMarker(text)) {
    return partialInfo("hermes_json", classifyIncompleteHermesJson(text), text);
  }
  if (hasQwenMarker(text)) {
    return partialInfo("qwen_xml", classifyIncompleteQwenXml(text), text);
  }
  if (hasMistralMarker(text)) {
    return partialInfo("mistral", "dangling_mistral_tool_call_fragment", text);
  }
  if (hasLlamaMarker(text)) {
    return partialInfo("llama", "dangling_llama_python_tag_fragment", text);
  }
  return undefined;
}

function hasFormatMarker(text: string, format: PartialTextToolCallFormat): boolean {
  switch (format) {
    case "qwen_xml":
      return hasQwenMarker(text) || hasLooseToolCommandFragment(text);
    case "deepseek_dsml":
      return hasDsmlMarker(text);
    case "hermes_json":
      return hasHermesMarker(text);
    case "mistral":
      return hasMistralMarker(text);
    case "llama":
      return hasLlamaMarker(text);
  }
}

function hasQwenMarker(text: string): boolean {
  return hasQwenSpecificMarker(text);
}

function hasQwenSpecificMarker(text: string): boolean {
  return /<function=|<\/function>|<parameter=|<\/parameter>/u.test(text);
}

function hasQwenParameterMarker(text: string): boolean {
  return /<parameter=|<\/parameter>/u.test(text);
}

function hasDsmlMarker(text: string): boolean {
  return text.includes("\uff5cDSML\uff5c");
}

function hasHermesMarker(text: string): boolean {
  return /<\/?tool_call>/u.test(text);
}

function hasMistralMarker(text: string): boolean {
  return text.includes("[TOOL_CALLS]");
}

function hasLlamaMarker(text: string): boolean {
  return text.includes("<|python_tag|>");
}

function hasLooseToolCommandFragment(text: string): boolean {
  return /(?:^|\n)\s*(?:Bash|bash|Shell|shell|Terminal|terminal)\/[^\s<]+/u.test(text);
}

function partialInfo(
  format: PartialTextToolCallFormat,
  reason: string,
  text: string,
): PartialTextToolCallInfo {
  return {
    format,
    reason,
    preview: preview(text),
  };
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "[empty]";
  }
  return compact.length > 240 ? `${compact.slice(0, 237).trimEnd()}...` : compact;
}

function generateId(): string {
  return `text_tc_${randomUUID().slice(0, 8)}`;
}

registerToolCallFormat({
  id: "qwen_xml",
  displayName: "Qwen XML",
  modelFamilies: ["qwen"],
  markers: ["<function=", "</function>", "<parameter=", "</parameter>"],
  parse: tryParseQwenXml,
  selfCorrectPrompt: "Use <function=TOOL_NAME> with one <parameter=NAME>VALUE</parameter> block for each argument, and close with </function>.",
  example: "<function=read_file>\n<parameter=path>/tmp/example.txt</parameter>\n</function>",
});

registerToolCallFormat({
  id: "deepseek_dsml",
  displayName: "DeepSeek DSML",
  modelFamilies: ["deepseek"],
  markers: ["\uff5cDSML\uff5c"],
  parse: tryParseDeepSeekDsml,
  selfCorrectPrompt: "Use one <｜DSML｜invoke name=\"TOOL_NAME\"> block with <｜DSML｜parameter name=\"ARG\">VALUE</content> children.",
  example: "<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"read_file\">\n<｜DSML｜parameter name=\"path\">/tmp/example.txt</content>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>",
});

registerToolCallFormat({
  id: "hermes_json",
  displayName: "Hermes JSON",
  modelFamilies: ["hermes", "nous"],
  markers: ["<tool_call>", "</tool_call>"],
  parse: tryParseHermesJson,
  selfCorrectPrompt: "Use a <tool_call> block containing valid JSON with string field name and object field arguments.",
  example: "<tool_call>\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/example.txt\"}}\n</tool_call>",
});

registerToolCallFormat({
  id: "mistral",
  displayName: "Mistral tool calls",
  modelFamilies: ["mistral", "mixtral"],
  markers: [MISTRAL_MARKER],
  parse: tryParseMistral,
  selfCorrectPrompt: "Use [TOOL_CALLS] followed by a valid JSON array of tool call objects with name and arguments.",
  example: "[TOOL_CALLS] [{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/example.txt\"}}]",
});

registerToolCallFormat({
  id: "llama",
  displayName: "Llama python-tag tool call",
  modelFamilies: ["llama"],
  markers: [LLAMA_TAG],
  parse: tryParseLlama,
  selfCorrectPrompt: "Use <|python_tag|> followed by a valid JSON object with name and arguments.",
  example: "<|python_tag|>{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/example.txt\"}}",
});
