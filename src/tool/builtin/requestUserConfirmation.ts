import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export const REQUEST_USER_CONFIRMATION_TOOL_NAME = "request_user_confirmation";

export type RequestUserConfirmationInput = {
  prompt: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: boolean;
};

export type RequestUserConfirmationOutput = {
  confirmed: boolean;
};

/**
 * Session-scoped boolean confirmation dialog. It is intentionally separate
 * from permission prompting: no permission rule is granted by an answer.
 */
export function createRequestUserConfirmationTool(): PilotDeckToolDefinition<
  RequestUserConfirmationInput,
  RequestUserConfirmationOutput
> {
  return {
    name: REQUEST_USER_CONFIRMATION_TOOL_NAME,
    aliases: ["RequestUserConfirmation"],
    description:
      "Ask the human user to confirm or decline one explicit decision during this task. " +
      "This does not grant permission for a tool; it only returns a boolean answer.",
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 16_000,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4_000, description: "The decision shown to the user." },
        confirmLabel: { type: "string", maxLength: 128, description: "Optional affirmative button label." },
        cancelLabel: { type: "string", maxLength: 128, description: "Optional negative button label." },
        defaultValue: { type: "boolean", description: "Optional default boolean selection." },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateRequestUserConfirmationInput(input),
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<RequestUserConfirmationOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext).userDialog;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "request_user_confirmation requires an enabled Gateway user-dialog channel.",
        );
      }
      const answer = await channel.requestConfirm({
        toolCallId: context.currentToolCallId ?? context.turnId,
        toolName: REQUEST_USER_CONFIRMATION_TOOL_NAME,
        prompt: input.prompt,
        ...(input.confirmLabel !== undefined ? { confirmLabel: input.confirmLabel } : {}),
        ...(input.cancelLabel !== undefined ? { cancelLabel: input.cancelLabel } : {}),
        ...(input.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      });
      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `The user cancelled the confirmation request${answer.reason ? `: ${answer.reason}` : "."}`,
        );
      }
      return {
        content: [{ type: "text", text: `The user confirmed: ${answer.value ? "yes" : "no"}` }],
        data: { confirmed: answer.value },
      };
    },
  };
}

function validateRequestUserConfirmationInput(input: RequestUserConfirmationInput): PilotDeckToolValidationResult {
  if (!input.prompt.trim()) return invalid("prompt", "prompt must be a non-empty string.");
  for (const [key, value] of [["confirmLabel", input.confirmLabel], ["cancelLabel", input.cancelLabel]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 128)) {
      return invalid(key, `${key} must be a non-empty string no longer than 128 characters.`);
    }
  }
  if (input.defaultValue !== undefined && typeof input.defaultValue !== "boolean") {
    return invalid("defaultValue", "defaultValue must be a boolean.");
  }
  return { ok: true, input };
}

function invalid(path: string, message: string): PilotDeckToolValidationResult {
  return { ok: false, issues: [{ path, code: "invalid_schema", message }] };
}
