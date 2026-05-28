import type { CanonicalModelResponse } from "../protocol/canonical.js";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../providers/anthropic/request.js";

export type StructuredOutputExtraction =
  | { ok: true; value: unknown }
  | { ok: false; reason: StructuredOutputExtractionError };

export type StructuredOutputExtractionError =
  | "no_payload"
  | "invalid_json"
  | "schema_mismatch"
  | "multiple_payloads";

export type ExtractStructuredOutputOptions = {
  /**
   * Optional minimal validator. PilotDeck does not pull in `ajv` for this
   * (deps stay zero); callers that want strict validation pass their own
   * validator. The extractor only catches structural errors otherwise.
   */
  validate?: (value: unknown) => boolean;
};

/**
 * Pull a structured payload out of a model response. Handles both:
 *   OpenAI    → response_format json_schema → assistant text is JSON-encoded
 *   Anthropic → forced `__output__` tool_use → input is the structured value
 *
 * Returns ok=true with the parsed value on success, ok=false with a coded
 * reason otherwise. Callers (agent loop, structured-output runtime) decide
 * whether to retry, surface to the user, or persist.
 *
 * Behaviour T_A3:
 *   - if multiple `__output__` tool_use blocks appear → multiple_payloads
 *   - if no payload at all → no_payload
 *   - if OpenAI text is not valid JSON → invalid_json
 *   - if a validator is supplied and rejects → schema_mismatch
 */
export function extractStructuredOutput(
  response: CanonicalModelResponse,
  options: ExtractStructuredOutputOptions = {},
): StructuredOutputExtraction {
  const toolBlocks = response.content.filter(
    (block) => block.type === "tool_call" && block.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
  );

  if (toolBlocks.length > 1) {
    return { ok: false, reason: "multiple_payloads" };
  }

  if (toolBlocks.length === 1) {
    const tool = toolBlocks[0]!;
    if (tool.type !== "tool_call") {
      return { ok: false, reason: "no_payload" };
    }
    const value = tool.input;
    if (options.validate && !options.validate(value)) {
      return { ok: false, reason: "schema_mismatch" };
    }
    return { ok: true, value };
  }

  // OpenAI path: assistant emits a single text block whose body is JSON.
  const textBlocks = response.content.filter((block) => block.type === "text");
  if (textBlocks.length === 0) {
    return { ok: false, reason: "no_payload" };
  }
  const joined = textBlocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (joined.length === 0) {
    return { ok: false, reason: "no_payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(joined);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (options.validate && !options.validate(parsed)) {
    return { ok: false, reason: "schema_mismatch" };
  }
  return { ok: true, value: parsed };
}
