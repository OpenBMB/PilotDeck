import type {
  CanonicalToolResultBlock,
  CanonicalToolResultContentBlock,
} from "./canonical.js";

export function toolResultContentBlockToText(block: CanonicalToolResultContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return block.source === "url"
        ? `[Image: ${block.mimeType}, ${block.data}]`
        : `[Image: ${block.mimeType}, ${block.data.length} base64 characters]`;
    case "pdf":
      return `[PDF: ${block.mimeType}, ${block.data.length} base64 characters${block.pages ? `, ${block.pages} pages` : ""}]`;
  }
}

export function flattenToolResultContentText(
  content: CanonicalToolResultContentBlock[],
): string {
  return content.map(toolResultContentBlockToText).join("\n");
}

export function flattenToolResultBlockText(block: CanonicalToolResultBlock): string {
  return flattenToolResultContentText(block.content);
}
