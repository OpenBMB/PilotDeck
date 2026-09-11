import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export const REQUEST_USER_CHOICE_TOOL_NAME = "request_user_choice";

export type RequestUserChoiceOption = {
  value: string;
  label?: string;
  description?: string;
};

export type RequestUserChoiceInput = {
  prompt: string;
  options: RequestUserChoiceOption[];
  defaultValue?: string;
};

export type RequestUserChoiceOutput = {
  selected: string;
};

/**
 * Session-scoped select dialog. The option list is part of the native tool
 * call, and the Gateway validates the returned value against that list before
 * it can resume the blocked ToolRuntime.
 */
export function createRequestUserChoiceTool(): PilotDeckToolDefinition<
  RequestUserChoiceInput,
  RequestUserChoiceOutput
> {
  return {
    name: REQUEST_USER_CHOICE_TOOL_NAME,
    aliases: ["RequestUserChoice"],
    description:
      "Ask the human user to choose exactly one option during this task. " +
      "Use this when a bounded decision is needed and the options can be stated clearly.",
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 16_000,
    inputSchema: {
      type: "object",
      required: ["prompt", "options"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          description: "The concise decision prompt shown to the user.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          description: "Two to twelve mutually exclusive choices for the user.",
          items: {
            type: "object",
            required: ["value"],
            additionalProperties: false,
            properties: {
              value: { type: "string", minLength: 1, maxLength: 512, description: "Stable value returned to the model." },
              label: { type: "string", maxLength: 512, description: "Optional display label for the host UI." },
              description: { type: "string", maxLength: 2_000, description: "Optional explanation of this choice." },
            },
          },
        },
        defaultValue: {
          type: "string",
          maxLength: 512,
          description: "Optional value selected by default. It must occur in options.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateRequestUserChoiceInput(input),
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<RequestUserChoiceOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext).userDialog;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "request_user_choice requires an enabled Gateway user-dialog channel.",
        );
      }
      const answer = await channel.requestSelect({
        toolCallId: context.currentToolCallId ?? context.turnId,
        toolName: REQUEST_USER_CHOICE_TOOL_NAME,
        prompt: input.prompt,
        choices: input.options.map((option) => ({ ...option })),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      });
      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `The user cancelled the choice request${answer.reason ? `: ${answer.reason}` : "."}`,
        );
      }
      return {
        content: [{ type: "text", text: `The user selected: ${answer.value}` }],
        data: { selected: answer.value },
      };
    },
  };
}

function validateRequestUserChoiceInput(input: RequestUserChoiceInput): PilotDeckToolValidationResult {
  if (!input.prompt.trim()) return invalid("prompt", "prompt must be a non-empty string.");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 12) {
    return invalid("options", "options must contain 2-12 choices.");
  }
  const values = new Set<string>();
  for (const [index, option] of input.options.entries()) {
    if (!option || typeof option.value !== "string" || !option.value.trim()) {
      return invalid(`options[${index}].value`, "each option value must be a non-empty string.");
    }
    if (option.value.length > 512 || option.label !== undefined && (typeof option.label !== "string" || option.label.length > 512)
      || option.description !== undefined && (typeof option.description !== "string" || option.description.length > 2_000)) {
      return invalid(`options[${index}]`, "choice values, labels, and descriptions exceed their limits.");
    }
    if (values.has(option.value)) return invalid(`options[${index}].value`, "choice values must be unique.");
    values.add(option.value);
  }
  if (input.defaultValue !== undefined && (!values.has(input.defaultValue) || input.defaultValue.length > 512)) {
    return invalid("defaultValue", "defaultValue must match one of the choice values.");
  }
  return { ok: true, input };
}

function invalid(path: string, message: string): PilotDeckToolValidationResult {
  return { ok: false, issues: [{ path, code: "invalid_schema", message }] };
}
