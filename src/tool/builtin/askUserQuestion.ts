import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";
import { validateHtmlPreview } from "../elicitation/validateHtmlPreview.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckElicitationRequest,
} from "../elicitation/PilotDeckElicitationChannel.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
/**
 * Header chip width — mirrors legacy
 * `ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12` (prompt.ts).
 */
export const ASK_USER_QUESTION_HEADER_MAX = 12;

const ASK_USER_QUESTION_DESCRIPTION =
  "Use this tool when you need to ask the user one or more multiple-choice questions during execution. " +
  "It is suitable for gathering preferences or requirements, clarifying ambiguous instructions, " +
  "getting decisions on implementation choices, or offering the user concrete directions to choose from. " +
  "Usage notes: provide 1-4 questions, each with 2-4 options; set multiSelect to true when a question " +
  "should allow multiple selections; phrase the choices yourself instead of using this tool for open-ended " +
  "free-form clarification. In plan mode, use ask_user_question to clarify requirements or choose between " +
  "approaches before finalizing your plan. Do not use it to ask for plan approval; use exit_plan_mode for that.";

export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionInput = {
  questions: AskUserQuestionItem[];
  /** Optional pre-supplied answers (echoed back to the model). */
  answers?: Record<string, string | string[]>;
  /** Optional per-question annotations (preview / notes). */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** Optional analytics metadata; not displayed to the user. */
  metadata?: { source?: string };
};

export type AskUserQuestionOutput = {
  questions: AskUserQuestionItem[];
  answers: Record<string, string | string[]>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
};

/**
 * Permission stage runs on the tool runtime; this is the moment we ask the
 * host to surface the multiple-choice dialog. The actual dispatch happens
 * via `runtimeContext.elicitation.askUser`.
 *
 * Behaviour alignment with `AskUserQuestionTool.tsx` (E1..E10 in §5.1.6):
 *   E1 schema: questions ≥ 1, ≤ 4 (legacy max).
 *   E2 each question.options ≥ 2, ≤ 4.
 *   E3 question texts unique within the call; option labels unique within
 *      each question (legacy `UNIQUENESS_REFINE`).
 *   E4 header.length ≤ ASK_USER_QUESTION_HEADER_MAX.
 *   E5 shouldDefer: true (legacy buildTool flag).
 *   E6 isReadOnly / isConcurrencySafe / requiresUserInteraction = true.
 *   E7 HTML preview validation (legacy `validateHtmlPreview`).
 *   E8 maxResultBytes = 100_000 (legacy `maxResultSizeChars`).
 *   E9 result mapping uses the legacy boilerplate format.
 *   E10 cancellation surfaces as `unsupported_tool` so the agent recovery
 *       loop can route back to the user via a fresh elicitation.
 */
export function createAskUserQuestionTool(): PilotDeckToolDefinition<
  AskUserQuestionInput,
  AskUserQuestionOutput
> {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    aliases: ["AskUserQuestion"],
    description: ASK_USER_QUESTION_DESCRIPTION,
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description:
            "Questions to ask the user. Provide 1-4 multiple-choice questions in one batch.",
          items: {
            type: "object",
            required: ["question", "header", "options"],
            additionalProperties: false,
            properties: {
              question: {
                type: "string",
                description:
                  "The full question shown to the user. Keep it clear and specific; if multiSelect is true, phrase it as a multi-select question.",
              },
              header: {
                type: "string",
                maxLength: ASK_USER_QUESTION_HEADER_MAX,
                description:
                  `Very short chip/tag label for the question (max ${ASK_USER_QUESTION_HEADER_MAX} chars).`,
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description:
                  "Available choices for this question. Provide 2-4 distinct options; they should be mutually exclusive unless multiSelect is true.",
                items: {
                  type: "object",
                  required: ["label", "description"],
                  additionalProperties: false,
                  properties: {
                    label: {
                      type: "string",
                      description:
                        "Short display text for the option. This is what the user selects.",
                    },
                    description: {
                      type: "string",
                      description:
                        "Explanation of what the option means or what choosing it implies.",
                    },
                    preview: {
                      type: "string",
                      description:
                        "Optional host-specific preview content associated with this option. Hosts may surface it alongside the choice and may echo the selected preview back in annotations.",
                    },
                  },
                },
              },
              multiSelect: {
                type: "boolean",
                description:
                  "Set to true to allow the user to select multiple options for this question instead of just one.",
              },
            },
          },
        },
        // Records keyed by free-form question text — schema validator only
        // checks the outer object shape; per-key types are enforced by
        // `validateInput` below.
        answers: {
          type: "object",
          description:
            "Optional pre-supplied answers keyed by question text. Values may be a single string or an array of strings for multi-select questions.",
        },
        annotations: {
          type: "object",
          description:
            "Optional per-question annotation data keyed by question text, such as selected preview text or free-form user notes returned by the host.",
        },
        metadata: {
          type: "object",
          additionalProperties: false,
          description:
            "Optional metadata forwarded to the host with the elicitation request. Not displayed to the user.",
          properties: {
            source: {
              type: "string",
              description:
                "Optional identifier describing why this question was asked, for host-side analytics or routing.",
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => {
      // E1: 1 ≤ questions ≤ 4. The JSON-Schema validator currently does not
      // enforce minItems/maxItems, so we double-check here.
      if (!Array.isArray(input.questions) || input.questions.length < 1) {
        return {
          ok: false,
          issues: [
            { path: "questions", code: "invalid_schema", message: "Provide 1-4 questions" },
          ],
        };
      }
      if (input.questions.length > 4) {
        return {
          ok: false,
          issues: [
            { path: "questions", code: "invalid_schema", message: "At most 4 questions allowed" },
          ],
        };
      }

      // E2: 2 ≤ options ≤ 4 per question.
      for (const q of input.questions) {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
          return {
            ok: false,
            issues: [
              {
                path: "questions[].options",
                code: "invalid_schema",
                message: `Question "${q.question}" must have 2-4 options`,
              },
            ],
          };
        }
      }

      // E3 uniqueness + E4 header length + E7 HTML preview validation.
      const seenQuestions = new Set<string>();
      for (const q of input.questions) {
        if (seenQuestions.has(q.question)) {
          return {
            ok: false,
            issues: [
              {
                path: "questions",
                code: "invalid_schema",
                message: `Question texts must be unique: "${q.question}"`,
              },
            ],
          };
        }
        seenQuestions.add(q.question);

        if (q.header.length > ASK_USER_QUESTION_HEADER_MAX) {
          return {
            ok: false,
            issues: [
              {
                path: "questions[].header",
                code: "invalid_schema",
                message: `header for "${q.question}" exceeds ${ASK_USER_QUESTION_HEADER_MAX} chars`,
              },
            ],
          };
        }

        const seenLabels = new Set<string>();
        for (const opt of q.options) {
          if (seenLabels.has(opt.label)) {
            return {
              ok: false,
              issues: [
                {
                  path: "questions[].options",
                  code: "invalid_schema",
                  message: `Option labels must be unique within question "${q.question}"`,
                },
              ],
            };
          }
          seenLabels.add(opt.label);

          const htmlError = validateHtmlPreview(opt.preview);
          if (htmlError !== null) {
            return {
              ok: false,
              issues: [
                {
                  path: "questions[].options[].preview",
                  code: "invalid_schema",
                  message: `Option "${opt.label}" in question "${q.question}": ${htmlError}`,
                },
              ],
            };
          }
        }
      }
      return { ok: true, input };
    },
    // No `checkPermissions` override: the elicitation channel itself IS the
    // user-consent gate (legacy behaviour — ask_user_question's `checkPermissions`
    // returns `behavior: "ask"` and the host renders the question UI directly).
    // PilotDeck would otherwise add a redundant "approve to ask" step in front
    // of the actual question dialog. The tool is read-only, so the runtime's
    // default mode allows it through.
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<AskUserQuestionOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext & {
        elicitation?: PilotDeckElicitationChannel;
      }).elicitation;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "ask_user_question requires a host elicitation channel (none registered).",
        );
      }

      // Pre-supplied answers short-circuit the channel call (legacy behaviour:
      // the schema accepts answers in input and the call() returns them as-is).
      if (input.answers && Object.keys(input.answers).length > 0) {
        const data: AskUserQuestionOutput = {
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations && { annotations: input.annotations }),
        };
        return {
          content: [
            { type: "text", text: formatAnswersForModel(input.answers, input.annotations) },
          ],
          data,
        };
      }

      const request: PilotDeckElicitationRequest = {
        toolCallId: context.turnId,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        questions: input.questions,
        ...(input.metadata && { metadata: input.metadata }),
        ...(context.abortSignal && { signal: context.abortSignal }),
      };
      const answer = await channel.askUser(request);

      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `User declined to answer questions${answer.reason ? ` (${answer.reason})` : ""}`,
        );
      }

      const data: AskUserQuestionOutput = {
        questions: input.questions,
        answers: answer.answers,
        ...(answer.annotations && { annotations: answer.annotations }),
      };
      return {
        content: [
          { type: "text", text: formatAnswersForModel(answer.answers, answer.annotations) },
        ],
        data,
      };
    },
  };
}

/**
 * Reproduces legacy `mapToolResultToToolResultBlockParam` byte-for-byte
 * (E9): "User has answered your questions: ...". The model uses this exact
 * phrasing as a routing hint.
 */
function formatAnswersForModel(
  answers: Record<string, string | string[]>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
): string {
  const entries = Object.entries(answers).map(([questionText, answer]) => {
    const annotation = annotations?.[questionText];
    const display = Array.isArray(answer) ? answer.join(", ") : answer;
    const parts = [`"${questionText}"="${display}"`];
    if (annotation?.preview) {
      parts.push(`selected preview:\n${annotation.preview}`);
    }
    if (annotation?.notes) {
      parts.push(`user notes: ${annotation.notes}`);
    }
    return parts.join(" ");
  });
  return `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind.`;
}
