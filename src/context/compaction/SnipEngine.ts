import type { CanonicalMessage } from "../../model/index.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  stripUnpairedToolCalls,
  stripUnpairedToolResults,
} from "./toolPairIntegrity.js";

export type SnipEngineOptions = {
  /** Number of head turns to keep (default 2). */
  keepHeadTurns?: number;
  /** Number of tail turns to keep (default 4). */
  keepTailTurns?: number;
  /** Master enable flag — when false, `snip` is a no-op (default true). */
  enabled?: boolean;
};

export type SnipResult = {
  messages: CanonicalMessage[];
  applied: boolean;
  /** Number of turns removed from the middle. */
  turnsSnipped: number;
  /** Number of dangling tool_call ids whose results were removed. */
  danglingToolCallIds: string[];
};

/**
 * Boundary marker injected between the kept head and tail. Looks like a
 * user-visible note (role=user, text content) so providers don't choke on
 * an unknown role. Callers recognize it via `isSnipBoundaryMessage`. The
 * payload is wrapped in an XML-style envelope so it's easy to detect and
 * never mistaken for normal user input.
 */
const SNIP_BOUNDARY_TEXT_PREFIX = "<snip-boundary";

export function createSnipBoundary(turnsSnipped: number, headTurns: number, tailTurns: number): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${SNIP_BOUNDARY_TEXT_PREFIX} turnsSnipped="${turnsSnipped}" headTurns="${headTurns}" tailTurns="${tailTurns}" />`,
      },
    ],
  };
}

export function isSnipBoundaryMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user" || message.content.length !== 1) return false;
  const block = message.content[0];
  if (!block || block.type !== "text") return false;
  return block.text.startsWith(SNIP_BOUNDARY_TEXT_PREFIX);
}

/**
 * A5 snip-compact engine. Aggressively prunes the middle of a long
 * conversation by turn (not token) so the provider sees only the head and
 * tail anchors plus a boundary marker.
 *
 * Behaviour rules:
 *   S1 turn boundaries: a "turn" starts at a user message that is NOT a
 *      tool_result-only message. Assistant + subsequent tool_result user
 *      messages are part of that turn.
 *   S2 keepHeadTurns / keepTailTurns default 2 / 4. Configurable.
 *   S3 No-op when total turns ≤ headTurns + tailTurns.
 *   S4 Tool-pair integrity: any tool_call in kept assistant messages with no
 *      matching tool_result in the kept tail is removed; the corresponding
 *      tool_result_only user messages dangling on the other side are also
 *      removed.
 *   S5 Boundary marker injected between head and tail.
 *   S6 `projectSnippedView` filters the input to head+boundary+tail in one
 *      call, used by callers that don't need the dangling-tool report.
 *   S7 Disabled engine returns input unchanged (intentional_difference: legacy
 *      uses an explicit SnipTool; PilotDeck uses an automatic policy).
 */
export class SnipEngine {
  private readonly keepHeadTurns: number;
  private readonly keepTailTurns: number;
  private readonly enabled: boolean;

  constructor(options: SnipEngineOptions = {}) {
    this.keepHeadTurns = Math.max(0, options.keepHeadTurns ?? 2);
    this.keepTailTurns = Math.max(1, options.keepTailTurns ?? 4);
    this.enabled = options.enabled ?? true;
  }

  snip(messages: CanonicalMessage[]): SnipResult {
    if (!this.enabled) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }
    const turns = splitIntoTurns(messages);
    if (turns.length <= this.keepHeadTurns + this.keepTailTurns) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }

    const head = turns.slice(0, this.keepHeadTurns).flat();
    const tail = turns.slice(turns.length - this.keepTailTurns).flat();
    const turnsSnipped = turns.length - this.keepHeadTurns - this.keepTailTurns;

    // S4: tool pair integrity.
    const tailToolResultIds = collectToolResultIds(tail);
    const headToolCallIds = collectToolCallIds(head);
    const tailToolCallIds = collectToolCallIds(tail);

    // From head: drop tool_calls whose tool_result is in the snipped middle.
    const headCleaned = stripUnpairedToolCalls(head, tailToolResultIds);
    // From tail: drop tool_results whose tool_call lives in the snipped middle.
    const allToolCallIds = new Set<string>([...headToolCallIds, ...tailToolCallIds]);
    const tailCleaned = stripUnpairedToolResults(tail, allToolCallIds);

    const dangling = Array.from(headToolCallIds).filter((id) => !tailToolResultIds.has(id));

    const boundary = createSnipBoundary(turnsSnipped, this.keepHeadTurns, this.keepTailTurns);

    return {
      messages: ensureTrailingUserMessage([...headCleaned, boundary, ...tailCleaned]),
      applied: true,
      turnsSnipped,
      danglingToolCallIds: dangling,
    };
  }
}

/**
 * S6: one-shot projection. Equivalent to `snip(messages).messages` but
 * always returns *some* projection — even if no snip happened, the input
 * is returned verbatim.
 */
export function projectSnippedView(
  messages: CanonicalMessage[],
  options: SnipEngineOptions = {},
): CanonicalMessage[] {
  return new SnipEngine(options).snip(messages).messages;
}

/**
 * Group messages into "turns". A turn is one user-initiated message
 * followed by all subsequent assistant + tool_result-bearing user messages
 * that share the same dispatch.
 */
function splitIntoTurns(messages: CanonicalMessage[]): CanonicalMessage[][] {
  const turns: CanonicalMessage[][] = [];
  let current: CanonicalMessage[] = [];
  for (const message of messages) {
    const isUserStart = message.role === "user" && !isToolResultOnly(message);
    if (isUserStart && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function isToolResultOnly(message: CanonicalMessage): boolean {
  if (message.content.length === 0) return false;
  return message.content.every((block) => block.type === "tool_result");
}

