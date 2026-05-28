import type { AgentContextRuntime, AgentContextPrepareInput, AgentPreparedContext } from "./ContextRuntime.js";
import type { CanonicalMessage } from "../model/index.js";

export class NullContextRuntime implements AgentContextRuntime {
  constructor(private readonly options: { maxMessages?: number } = {}) {}

  async prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext> {
    const maxMessages = input.maxMessages ?? this.options.maxMessages;
    if (maxMessages !== undefined && input.messages.length > maxMessages) {
      return {
        messages: toolPairSafeSlice(input.messages, maxMessages),
        systemPromptParts: [],
        tools: input.tools,
        boundaries: [{ type: "compact", retainedMessages: maxMessages }],
        diagnostics: [
          {
            code: "context_truncated",
            severity: "warning",
            message: `Context was truncated to the last ${maxMessages} messages.`,
          },
        ],
      };
    }

    return {
      messages: input.messages,
      systemPromptParts: [],
      tools: input.tools,
      boundaries: [],
      diagnostics: [
        {
          code: "context_budget_not_enforced",
          severity: "info",
          message: "Token-level context budget is not enforced in the null context runtime.",
        },
      ],
    };
  }
}

/**
 * Slice the last `max` messages, but push the cut point earlier if it would
 * land between an assistant tool_calls message and its tool_result responses.
 */
function toolPairSafeSlice(messages: CanonicalMessage[], max: number): CanonicalMessage[] {
  if (messages.length <= max) return messages;
  let cut = messages.length - max;
  while (cut < messages.length && isToolResultOnly(messages[cut])) {
    cut--;
  }
  if (cut < 0) cut = 0;
  return messages.slice(cut);
}

function isToolResultOnly(message: CanonicalMessage): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}
