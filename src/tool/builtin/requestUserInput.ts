import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

export type RequestUserInputInput = {
  prompt: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type RequestUserInputOutput = {
  answer: string;
};

/**
 * Session-scoped generic input dialog. The Gateway only registers this tool
 * for SDK sessions that explicitly enable the `input` dialog kind.
 */
export function createRequestUserInputTool(): PilotDeckToolDefinition<
  RequestUserInputInput,
  RequestUserInputOutput
> {
  return {
    name: REQUEST_USER_INPUT_TOOL_NAME,
    aliases: ["RequestUserInput"],
    description:
      "Ask the human user for one short free-form answer during this task. " +
      "Use this only when a concise clarification is required and multiple-choice " +
      "ask_user_question is unsuitable.",
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 16_000,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          description: "The concise question or request shown to the user.",
        },
        placeholder: {
          type: "string",
          maxLength: 512,
          description: "Optional input placeholder shown by the host UI.",
        },
        allowEmpty: {
          type: "boolean",
          description: "Whether the host may submit an empty answer.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    // Registration itself is the opt-in capability gate: only a session with
    // a Gateway-owned dialog channel can see this tool. Do not reuse the
    // generic `canPrompt` gate, which controls permission prompting and would
    // otherwise require an unrelated `canUseTool` callback from SDK clients.
    requiresUserInteraction: () => false,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<RequestUserInputOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext).userDialog;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "request_user_input requires an enabled Gateway user-dialog channel.",
        );
      }
      const answer = await channel.requestInput({
        toolCallId: context.currentToolCallId ?? context.turnId,
        toolName: REQUEST_USER_INPUT_TOOL_NAME,
        prompt: input.prompt,
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
        ...(input.allowEmpty === true ? { allowEmpty: true } : {}),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      });
      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `The user cancelled the input request${answer.reason ? `: ${answer.reason}` : "."}`,
        );
      }
      if (!input.allowEmpty && !answer.value.trim()) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "The user submitted an empty response for a required input request.",
        );
      }
      return {
        content: [{ type: "text", text: `The user answered: ${answer.value}` }],
        data: { answer: answer.value },
      };
    },
  };
}
