/**
 * Child-facing delivery prompt and reviewer-agnostic protocol prefix.
 *
 * The child receives an editable guidance text plus (if the parent supplied
 * one) the incremental schema. The host parses the child's final message and
 * archives the delivery itself, so the child never needs a write tool call
 * just for reporting.
 */

/** Stable, short protocol prefix used in Auto mode. */
const PROTOCOL_PREFIX = [
  "Delivery protocol:",
  "- Return your final message as exactly one JSON object (a single enclosing ```json fence is also fine).",
  "- The host parses that object as your delivery report and returns its host-owned delivery_file path to the parent; you do not need a write tool call solely for reporting.",
  "- Declare every produced file as a {\"file\": \"<workspace-relative path>\"} object so it can be machine-verified.",
  "- Files you declare are checked for existence on disk. Never invent a path or claim proof you cannot show.",
].join("\n");

export const DEFAULT_DELIVERY_PROMPT = [
  "Report your finished work as the delivery JSON described above. The example below is illustrative,",
  "not mandatory: reorganize it and add your own fields as the task requires. If the parent supplied a",
  "schema, treat it as incremental guidance on top of whatever structure you choose; all of its fields",
  "are optional and unknown fields are allowed. Omit empty sections entirely rather than padding them.",
  "",
  "Example (illustrative):",
  "```json",
  "{",
  '  "summary": "One paragraph on what was done and the outcome.",',
  '  "inputs": [',
  '    {"file": "docs/spec.md", "note": "requirements used"}',
  "  ],",
  '  "changes": [',
  '    {"file": "src/util.ts", "description": "added the parser", "locations": [{"startLine": 10, "endLine": 42}]}',
  "  ],",
  '  "artifacts": [',
  '    {"role": "result", "file": "out/report.pdf"},',
  '    {"role": "intermediate", "file": "scratch/notes.md"}',
  "  ],",
  '  "result": {',
  '    "status": "done",',
  '    "text": "For pure-text results, put the content here instead of writing a file.",',
  '    "file": "out/main-deliverable.md"',
  "  }",
  "}",
  "```",
  "",
  "Notes:",
  "- For custom layouts, mark result-file objects with role: result or final so the reviewer can select them. Inputs and intermediate files are listed without expanding their content.",
  "- For deletions, report the former path in a description or deleted_path, not as an existing file declaration.",
  "- \"summary\" is a claim; \"result.file\" and \"artifacts\" are verifiable evidence. Include both when you can.",
  "- \"locations\" entries are optional and only checked when you supply positive integer line numbers.",
  "- Files you reference must actually exist in the workspace; presence is verified, never assumed.",
].join("\n");

export type BuildDeliveryPromptOptions = {
  /** Parent override. `undefined` → default guidance; empty/whitespace → protocol only. */
  prompt?: string;
  /** Incremental parent schema rendered for the child, if any. */
  schema?: Record<string, unknown>;
};

/**
 * Builds the child-facing delivery instruction: stable protocol prefix +
 * editable guidance + optional parent schema. Never mandates specific fields.
 */
export function buildDeliveryPrompt(options: BuildDeliveryPromptOptions = {}): string {
  const parts: string[] = [PROTOCOL_PREFIX];

  const guidance = options.prompt;
  if (guidance === undefined) {
    parts.push(DEFAULT_DELIVERY_PROMPT);
  } else if (guidance.trim().length > 0) {
    parts.push(guidance.trim());
  }

  if (options.schema && Object.keys(options.schema).length > 0) {
    parts.push(
      [
        "Parent schema (incremental guidance only; every field is optional, unknown fields are allowed):",
        "```json",
        JSON.stringify(options.schema, null, 2),
        "```",
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}
