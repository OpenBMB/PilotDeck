import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import { validateFormDialogSchema, type FormDialogSchema } from "../dialog/FormDialogSchema.js";

export const REQUEST_USER_FORM_TOOL_NAME = "request_user_form";

export type RequestUserFormInput = {
  prompt: string;
  schema: FormDialogSchema;
};

export type RequestUserFormOutput = {
  values: Record<string, unknown>;
};

/**
 * Session-scoped schema-backed form dialog. It is registered only for SDK
 * sessions that explicitly opt in, and its answer is validated by the
 * Gateway before the native ToolRuntime resumes the call.
 */
export function createRequestUserFormTool(): PilotDeckToolDefinition<RequestUserFormInput, RequestUserFormOutput> {
  return {
    name: REQUEST_USER_FORM_TOOL_NAME,
    aliases: ["RequestUserForm"],
    description:
      "Ask the human user to fill a structured form during this task. " +
      "Use a JSON object schema with fields, required entries, nested objects or arrays, and scalar enums.",
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 32_000,
    inputSchema: {
      type: "object",
      required: ["prompt", "schema"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          description: "The concise instruction shown above the form.",
        },
        schema: {
          type: "object",
          additionalProperties: true,
          description: "A supported JSON object schema that describes the form response.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => false,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => validateRequestUserFormInput(input),
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<RequestUserFormOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext).userDialog;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "request_user_form requires an enabled Gateway user-dialog channel.",
        );
      }
      const answer = await channel.requestForm({
        toolCallId: context.currentToolCallId ?? context.turnId,
        toolName: REQUEST_USER_FORM_TOOL_NAME,
        prompt: input.prompt,
        schema: input.schema,
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      });
      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `The user cancelled the form request${answer.reason ? `: ${answer.reason}` : "."}`,
        );
      }
      return {
        content: [{ type: "json", value: answer.value }],
        data: { values: answer.value },
      };
    },
  };
}

function validateRequestUserFormInput(input: RequestUserFormInput): PilotDeckToolValidationResult {
  if (!input.prompt.trim()) return invalid("prompt", "prompt must be a non-empty string.");
  const schema = validateFormDialogSchema(input.schema);
  return schema.ok ? { ok: true, input: { ...input, schema: schema.schema } } : invalid("schema", schema.message);
}

function invalid(path: string, message: string): PilotDeckToolValidationResult {
  return { ok: false, issues: [{ path, code: "invalid_schema", message }] };
}
