import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";

export const SEARCH_TOOLS_TOOL_NAME = "search_tools";

export type DeferredToolSearchEntry = {
  name: string;
  description: string;
  searchHint?: string;
};

export type CreateDeferredToolSearchToolOptions = {
  registry: ToolRegistry;
  tools: DeferredToolSearchEntry[];
};

/**
 * Exposes a small, session-local catalog for tools withheld from the initial
 * model schema. Matching tools are revealed in the existing ToolRegistry, so
 * the next native AgentLoop request and ToolRuntime use their ordinary paths.
 */
export function createDeferredToolSearchTool(
  options: CreateDeferredToolSearchToolOptions,
): PilotDeckToolDefinition {
  const entries = uniqueEntries(options.tools);
  return {
    name: SEARCH_TOOLS_TOOL_NAME,
    description: "Search deferred tools by capability. Matching tools become available for the next model request.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "The capability or task to search for.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => {
      const query = typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query.trim()
        : "";
      if (!query) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", "search_tools requires a non-empty query.");
      }
      const matches = findMatches(entries, query);
      for (const entry of matches) options.registry.reveal(entry.name);
      const text = matches.length === 0
        ? `No deferred tools matched ${JSON.stringify(query)}.`
        : [
            `Loaded ${matches.length} deferred tool${matches.length === 1 ? "" : "s"}:`,
            ...matches.map((entry) => `- ${entry.name}: ${entry.description}`),
            "Use the loaded tool names in a subsequent tool call.",
          ].join("\n");
      return {
        content: [{ type: "text", text }],
        data: {
          query,
          tools: matches.map((entry) => ({
            name: entry.name,
            description: entry.description,
            ...(entry.searchHint ? { searchHint: entry.searchHint } : {}),
          })),
        },
      };
    },
  };
}

function uniqueEntries(entries: DeferredToolSearchEntry[]): DeferredToolSearchEntry[] {
  const byName = new Map<string, DeferredToolSearchEntry>();
  for (const entry of entries) {
    if (!entry.name.trim() || byName.has(entry.name)) continue;
    byName.set(entry.name, {
      name: entry.name,
      description: entry.description,
      ...(entry.searchHint ? { searchHint: entry.searchHint } : {}),
    });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function findMatches(entries: DeferredToolSearchEntry[], query: string): DeferredToolSearchEntry[] {
  const normalized = query.toLocaleLowerCase();
  const exact = entries.filter((entry) => searchText(entry).includes(normalized));
  if (exact.length > 0) return exact;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return entries.filter((entry) => {
    const text = searchText(entry);
    return tokens.every((token) => text.includes(token));
  });
}

function searchText(entry: DeferredToolSearchEntry): string {
  return [entry.name, entry.description, entry.searchHint ?? ""].join(" ").toLocaleLowerCase();
}
