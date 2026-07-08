import type { TextToolCallParseResult, PartialTextToolCallFormat } from "./parseTextToolCalls.js";

export type ToolCallFormatDefinition = {
  id: PartialTextToolCallFormat;
  displayName: string;
  modelFamilies: string[];
  markers: string[];
  parse: (text: string) => TextToolCallParseResult | null;
  selfCorrectPrompt: string;
  example: string;
};

const registry: ToolCallFormatDefinition[] = [];

export function registerToolCallFormat(format: ToolCallFormatDefinition): void {
  const existing = registry.findIndex((entry) => entry.id === format.id);
  if (existing >= 0) {
    registry[existing] = format;
    return;
  }
  registry.push(format);
}

export function getToolCallFormats(): readonly ToolCallFormatDefinition[] {
  return registry;
}

export function getFormatById(id: string | undefined): ToolCallFormatDefinition | undefined {
  if (!id || id === "auto") return undefined;
  return registry.find((format) => format.id === id);
}

export function detectFormatByText(text: string): ToolCallFormatDefinition | undefined {
  return registry.find((format) => format.markers.some((marker) => text.includes(marker)));
}

export function looksLikeUnparsedToolCall(text: string): boolean {
  return detectFormatByText(text) !== undefined;
}

export function getSelfCorrectPrompt(
  formatId: string | undefined,
  failedText: string,
): string {
  const selected = getFormatById(formatId) ?? detectFormatByText(failedText) ?? registry[0];
  const excerpt = failedText.trim().slice(0, 2_000);
  if (!selected) {
    return [
      "Your previous response looked like a tool call, but it could not be parsed.",
      "Retry by emitting exactly one valid tool call using the required tool-call syntax.",
      "Do not explain the mistake or wrap the tool call in Markdown.",
      excerpt ? `Previous unparsable text:\n${excerpt}` : undefined,
    ].filter(Boolean).join("\n\n");
  }

  return [
    `Your previous response looked like a ${selected.displayName} tool call, but it could not be parsed.`,
    selected.selfCorrectPrompt,
    "Retry by emitting exactly one valid tool call. Do not explain the mistake or wrap the tool call in Markdown.",
    `Example:\n${selected.example}`,
    excerpt ? `Previous unparsable text:\n${excerpt}` : undefined,
  ].filter(Boolean).join("\n\n");
}
