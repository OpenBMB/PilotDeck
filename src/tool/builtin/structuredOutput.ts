import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type StructuredOutputInput = {
  value: unknown;
};

export function createStructuredOutputTool(): PilotDeckToolDefinition<StructuredOutputInput> {
  return {
    name: "structured_output",
    aliases: ["StructuredOutput"],
    description: "Return a final structured output payload for non-interactive hosts.",
    kind: "structured_output",
    inputSchema: {
      type: "object",
      required: ["value"],
      additionalProperties: false,
      properties: {
        value: {
          type: ["object", "array", "string", "number", "boolean"],
          description: "The structured payload to return (any JSON-serializable value).",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => ({
      content: [{ type: "json", value: input.value }],
      data: input.value,
      metadata: { structuredOutput: true },
    }),
  };
}
