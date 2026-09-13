/**
 * Build the initial message sequence for a subagent fork.
 *
 * Each subagent starts with a clean context — only the directive from the
 * parent's `agent` tool call is forwarded. No parent assistant messages
 * (thinking, text, or sibling tool_calls) are included, so the child model
 * cannot infer or attempt tasks belonging to other sibling subagents.
 */

import type { CanonicalMessage } from "../../model/index.js";

/** Tag used in the boilerplate that wraps the directive. */
export const FORK_BOILERPLATE_TAG = "pilotdeck-fork";

export const FORK_PLACEHOLDER_RESULT =
  "<pilotdeck-fork-placeholder>Subtask handled by forked subagent — see child transcript.</pilotdeck-fork-placeholder>";

export function buildForkedMessages(directive: string, initialPrompt?: string): CanonicalMessage[] {
  const prefix = initialPrompt?.trim();
  return [
    ...(prefix ? [{ role: "user" as const, content: [{ type: "text" as const, text: prefix }] }] : []),
    { role: "user", content: [{ type: "text", text: directive }] },
  ];
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>\nDirective:\n${directive.trim()}\n</${FORK_BOILERPLATE_TAG}>`;
}
