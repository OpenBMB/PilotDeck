import type { CanonicalContentBlock } from "../protocol/canonical.js";

type ToolResultReferenceBlock = Extract<CanonicalContentBlock, { type: "tool_result_reference" }>;

export function formatToolResultReferenceText(block: ToolResultReferenceBlock): string {
  if (!block.hasMore) {
    return block.preview;
  }
  const filePath = block.readFilePath ?? block.path;
  return block.preview
    + `\n\n[Tool result preview only: original ${block.originalBytes} bytes. Full output was saved at: ${filePath}. `
    + `To inspect it, first search within the persisted result with grep({ pattern: "<keyword>", path: "${filePath}", output_mode: "content", head_limit: 20 }) for relevant names, IDs, errors, URLs, dates, or candidate terms. `
    + `Then read only the matching neighborhood with read_file({ file_path: "${filePath}", offset: <line>, limit: 80 }) when surrounding context is needed. `
    + "Avoid paging through the whole file from offset 1 unless the task truly requires a complete sequential review. "
    + "If the task depends on complete lists, counts, search candidates, evidence checks, or long page content, use grep/refined searches and targeted reads on the persisted result before concluding.]";
}
