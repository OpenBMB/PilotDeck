/**
 * S1-S3 — fork the parent's assistant message into a child-side message
 * sequence so the subagent inherits the parent's reasoning trace cache-safely.
 *
 * The exact byte-for-byte placeholder string and message shape are critical
 * for prompt-cache hits — do not casually tweak the wording or block order
 * here, even when it looks harmless.
 */

import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolCallBlock,
} from "../../model/index.js";

/**
 * S2 — placeholder string injected into every synthetic `tool_result` so the
 * fork is byte-identical across siblings (= cache hit on Anthropic / OpenAI).
 *
 * **Do not change** without a coordinated cache invalidation plan; both legacy
 * and parity tests assert the literal value.
 */
export const FORK_PLACEHOLDER_RESULT =
  "<pilotdeck-fork-placeholder>Subtask handled by forked subagent — see child transcript.</pilotdeck-fork-placeholder>";

/** Tag used in the boilerplate that wraps the directive. */
export const FORK_BOILERPLATE_TAG = "pilotdeck-fork";

/**
 * S1 — Build the canonical message sequence handed to the subagent's
 * `AgentLoop`:
 *
 *   1. Parent's assistant message verbatim (thinking + every tool_use + text).
 *   2. A user message containing one synthetic `tool_result` (with
 *      `FORK_PLACEHOLDER_RESULT`) per `tool_use`, followed by the directive
 *      wrapped in `<pilotdeck-fork>` boilerplate.
 *
 * Returns a fresh array (never mutates `assistantMessage`).
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: CanonicalMessage,
): CanonicalMessage[] {
  if (assistantMessage.role !== "assistant") {
    throw new Error(
      "buildForkedMessages: parent message must be role=assistant; got " +
        assistantMessage.role,
    );
  }
  const userBlocks: CanonicalContentBlock[] = [];
  for (const block of assistantMessage.content) {
    if (block.type === "tool_call") {
      const tc = block as CanonicalToolCallBlock;
      userBlocks.push({
        type: "tool_result",
        toolCallId: tc.id,
        content: [{ type: "text", text: FORK_PLACEHOLDER_RESULT }],
      });
    }
  }
  userBlocks.push({ type: "text", text: buildChildMessage(directive) });
  return [
    cloneMessage(assistantMessage),
    { role: "user", content: userBlocks },
  ];
}

/**
 * S3 — child directive wrapped in fork boilerplate. Rules and output format
 * live in the system prompt ({@link buildSubagentSystemPrompt}) and are NOT
 * duplicated here — keeping the user message slim improves memory-retrieval
 * signal-to-noise and saves ~200-300 tokens per sub-agent.
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>\nDirective:\n${directive.trim()}\n</${FORK_BOILERPLATE_TAG}>`;
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    role: message.role,
    content: message.content.map((block) => ({ ...block })),
  };
}
