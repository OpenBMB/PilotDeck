import { randomUUID } from "node:crypto";
import type { CanonicalToolCall } from "../protocol/canonical.js";

export type TextToolCallParseResult = {
  toolCalls: CanonicalToolCall[];
  remainingText: string;
};

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
  const parsers = [
    tryParseQwenXml,
    tryParseDeepSeekDsml,
    tryParseHermesJson,
    tryParseMistral,
    tryParseLlama,
  ];

  for (const parser of parsers) {
    const result = parser(text);
    if (result && result.toolCalls.length > 0) {
      return result;
    }
  }

  return { toolCalls: [], remainingText: text };
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
  if (!text.includes("<function=")) return null;

  const toolCalls: CanonicalToolCall[] = [];
  let remaining = text;

  for (const match of text.matchAll(QWEN_FUNC_RE)) {
    const name = match[1];
    const body = match[2];
    const input: Record<string, string> = {};

    for (const paramMatch of body.matchAll(QWEN_PARAM_RE)) {
      input[paramMatch[1]] = paramMatch[2].trim();
    }

    toolCalls.push({
      id: generateId(),
      name,
      input,
    });
  }

  if (toolCalls.length === 0) return null;

  remaining = remaining.replace(QWEN_FUNC_RE, "");
  remaining = remaining.replace(/<\/?tool_call>/g, "");
  remaining = remaining.replace(/<\/think>/g, "");
  remaining = remaining.trim();

  return { toolCalls, remainingText: remaining };
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
  if (!text.includes("\uff5cDSML\uff5c")) return null;

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

  if (toolCalls.length === 0) return null;

  let remaining = text.replace(/<\uff5cDSML\uff5ctool_calls>[\s\S]*?<\/\uff5cDSML\uff5ctool_calls>/g, "").trim();
  return { toolCalls, remainingText: remaining };
}

// ---------------------------------------------------------------------------
// Format C — Hermes / NousResearch JSON-in-XML
// <tool_call>
// {"name": "TOOL_NAME", "arguments": {...}}
// </tool_call>
// ---------------------------------------------------------------------------

const HERMES_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

function tryParseHermesJson(text: string): TextToolCallParseResult | null {
  if (!text.includes("<tool_call>")) return null;
  if (text.includes("<function=")) return null;

  const toolCalls: CanonicalToolCall[] = [];

  for (const match of text.matchAll(HERMES_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateId(),
          name: parsed.name,
          input: parsed.arguments ?? parsed.parameters ?? {},
        });
      }
    } catch {
      continue;
    }
  }

  if (toolCalls.length === 0) return null;

  let remaining = text.replace(HERMES_RE, "").trim();
  return { toolCalls, remainingText: remaining };
}

// ---------------------------------------------------------------------------
// Format D — Mistral / Devstral
// [TOOL_CALLS][{"name": "TOOL_NAME", "arguments": {...}}]
// ---------------------------------------------------------------------------

const MISTRAL_RE = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/;

function tryParseMistral(text: string): TextToolCallParseResult | null {
  if (!text.includes("[TOOL_CALLS]")) return null;

  const match = text.match(MISTRAL_RE);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;

    const toolCalls: CanonicalToolCall[] = parsed
      .filter((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return obj && typeof obj.name === "string";
      })
      .map((item: Record<string, unknown>) => ({
        id: generateId(),
        name: item.name as string,
        input: (item.arguments ?? item.parameters ?? {}) as unknown,
      }));

    if (toolCalls.length === 0) return null;

    let remaining = text.replace(MISTRAL_RE, "").trim();
    return { toolCalls, remainingText: remaining };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format E — Llama 3.x / 4.x
// <|python_tag|>{"name": "TOOL_NAME", "parameters": {...}}
// ---------------------------------------------------------------------------

const LLAMA_RE = /<\|python_tag\|>\s*(\{[\s\S]*?\})/g;

function tryParseLlama(text: string): TextToolCallParseResult | null {
  if (!text.includes("<|python_tag|>")) return null;

  const toolCalls: CanonicalToolCall[] = [];

  for (const match of text.matchAll(LLAMA_RE)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateId(),
          name: parsed.name,
          input: parsed.parameters ?? parsed.arguments ?? {},
        });
      }
    } catch {
      continue;
    }
  }

  if (toolCalls.length === 0) return null;

  let remaining = text.replace(LLAMA_RE, "").trim();
  return { toolCalls, remainingText: remaining };
}

// ---------------------------------------------------------------------------

function generateId(): string {
  return `text_tc_${randomUUID().slice(0, 8)}`;
}
