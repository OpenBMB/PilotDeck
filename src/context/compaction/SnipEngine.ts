import type { CanonicalMessage } from "../../model/index.js";
import { TokenBudgetManager } from "../budget/TokenBudgetManager.js";
import {
  collectToolCallIds,
  collectToolResultIds,
  ensureTrailingUserMessage,
  isRealUserRequestMessage,
  stripUnpairedToolCalls,
  stripUnpairedToolResults,
} from "./toolPairIntegrity.js";
import {
  collectToolNamesByCallId,
  collectProtectedTurnIndexes,
  isProtectedContextMessage,
  protectedToolNameSet,
} from "./protectedContext.js";

export type SnipEngineOptions = {
  /** Number of head turns to keep (default 2). */
  keepHeadTurns?: number;
  /** Number of tail turns to keep (default 4). */
  keepTailTurns?: number;
  /** Master enable flag — when false, `snip` is a no-op (default true). */
  enabled?: boolean;
  /** Tool names whose turns should be preserved verbatim. */
  protectedToolNames?: Iterable<string>;
  /** Optional token target for the retained live tail. */
  targetTokens?: number;
  /** Optional token target for the complete prompt, including checkpoints. */
  targetTotalTokens?: number;
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
  private readonly protectedToolNames: ReadonlySet<string>;
  private readonly tokenBudget = new TokenBudgetManager();

  constructor(options: SnipEngineOptions = {}) {
    this.keepHeadTurns = Math.max(0, options.keepHeadTurns ?? 2);
    this.keepTailTurns = Math.max(1, options.keepTailTurns ?? 4);
    this.enabled = options.enabled ?? true;
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  snip(messages: CanonicalMessage[], options: Pick<SnipEngineOptions, "targetTokens" | "targetTotalTokens"> = {}): SnipResult {
    if (!this.enabled) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }
    const prefixCount = checkpointPrefixMessageCount(messages);
    const stablePrefix = messages.slice(0, prefixCount);
    const stablePrefixTokens = this.tokenBudget.estimateMessagesTokens(stablePrefix);
    const targetTokens = options.targetTotalTokens !== undefined
      ? Math.max(1, Math.floor(options.targetTotalTokens) - stablePrefixTokens)
      : options.targetTokens;
    const constrained = targetTokens !== undefined;
    const liveMessages = messages.slice(prefixCount);
    const turns = constrained ? splitIntoToolCycles(liveMessages) : splitIntoTurns(liveMessages);
    if (!constrained && turns.length <= this.keepHeadTurns + this.keepTailTurns) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }

    const keepIndexes = new Set<number>();
    if (targetTokens === undefined) {
      for (let index = 0; index < Math.min(this.keepHeadTurns, turns.length); index += 1) {
        keepIndexes.add(index);
      }
    }
    let accumulatedTailTokens = 0;
    let tailStartIndex = turns.length;
    const tailFloor = Math.min(constrained ? 1 : this.keepTailTurns, turns.length);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const tokens = this.tokenBudget.estimateMessagesTokens(turns[index]!);
      const mustKeep = turns.length - index <= tailFloor;
      if (!mustKeep && targetTokens !== undefined
        && accumulatedTailTokens + tokens > Math.max(1, targetTokens)) {
        break;
      }
      keepIndexes.add(index);
      tailStartIndex = index;
      accumulatedTailTokens += tokens;
    }
    const requestAnchorIndex = findLatestUserRequestGroupIndex(turns, tailStartIndex);
    if (requestAnchorIndex !== undefined) {
      keepIndexes.add(requestAnchorIndex);
    }
    // Protected indexes are relative to the live turn list. Checkpoint
    // messages are intentionally excluded from `turns`, so calculating these
    // indexes against the full input would shift every protected turn after
    // the checkpoint and could preserve the wrong middle turn.
    const protectedIndexes = constrained
      ? collectProtectedCycleIndexes(turns, liveMessages, this.protectedToolNames)
      : collectProtectedTurnIndexes(liveMessages, { protectedToolNames: this.protectedToolNames });
    for (const index of protectedIndexes) {
      keepIndexes.add(index);
    }
    if (keepIndexes.size >= turns.length) {
      return { messages, applied: false, turnsSnipped: 0, danglingToolCallIds: [] };
    }

    const turnsSnipped = turns.length - keepIndexes.size;
    const projected = [
      ...stablePrefix,
      ...stitchKeptTurnsWithBoundaries(turns, keepIndexes, this.keepHeadTurns, this.keepTailTurns),
    ];

    // S4: tool pair integrity.
    const toolResultIds = collectToolResultIds(projected);
    const toolCallIds = collectToolCallIds(projected);
    const withoutDanglingCalls = stripUnpairedToolCalls(projected, toolResultIds);
    const pairedToolCallIds = collectToolCallIds(withoutDanglingCalls);
    const cleaned = stripUnpairedToolResults(withoutDanglingCalls, pairedToolCallIds);

    const dangling = Array.from(toolCallIds).filter((id) => !toolResultIds.has(id));

    return {
      messages: ensureTrailingUserMessage(cleaned),
      applied: true,
      turnsSnipped,
      danglingToolCallIds: dangling,
    };
  }
}

function checkpointPrefixMessageCount(messages: CanonicalMessage[]): number {
  let index = 0;
  while (index + 1 < messages.length
    && isCompactBoundary(messages[index]!)
    && isSummaryMessage(messages[index + 1]!)) {
    index += 2;
  }
  return index;
}

function isCompactBoundary(message: CanonicalMessage): boolean {
  return message.role === "user"
    && message.content.some((block) => block.type === "text" && block.text.startsWith("<compact-boundary"));
}

function isSummaryMessage(message: CanonicalMessage): boolean {
  return message.role === "assistant"
    && message.content.some((block) => block.type === "text" && block.text.startsWith("[CONTEXT COMPACTION - REFERENCE ONLY]"));
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

function splitIntoToolCycles(messages: CanonicalMessage[]): CanonicalMessage[][] {
  const groups: CanonicalMessage[][] = [];
  let current: CanonicalMessage[] = [];
  const flush = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
  };

  for (const message of messages) {
    if ((message.role === "user" && !isToolResultOnly(message)) || message.role === "assistant") {
      flush();
    }
    current.push(message);
  }
  flush();
  return groups;
}

function collectProtectedCycleIndexes(
  groups: CanonicalMessage[][],
  messages: CanonicalMessage[],
  protectedToolNames: ReadonlySet<string>,
): Set<number> {
  const toolNamesByCallId = collectToolNamesByCallId(messages);
  const protectedIndexes = new Set<number>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    if (!group.some((message) => isProtectedContextMessage(message, {
      protectedToolNames,
      toolNamesByCallId,
    }))) {
      continue;
    }
    protectedIndexes.add(index);
    const requestAnchorIndex = findLatestUserRequestGroupIndex(groups, index);
    if (requestAnchorIndex !== undefined) {
      protectedIndexes.add(requestAnchorIndex);
    }
  }
  return protectedIndexes;
}

function findLatestUserRequestGroupIndex(
  groups: CanonicalMessage[][],
  atOrBefore: number,
): number | undefined {
  for (let index = Math.min(atOrBefore, groups.length - 1); index >= 0; index -= 1) {
    if (groups[index]!.some(isRealUserRequestMessage)) {
      return index;
    }
  }
  return undefined;
}

function stitchKeptTurnsWithBoundaries(
  turns: CanonicalMessage[][],
  keepIndexes: Set<number>,
  headTurns: number,
  tailTurns: number,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  let skipped = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (!keepIndexes.has(index)) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      out.push(createSnipBoundary(skipped, headTurns, tailTurns));
      skipped = 0;
    }
    out.push(...turns[index]!);
  }
  if (skipped > 0) {
    out.push(createSnipBoundary(skipped, headTurns, tailTurns));
  }
  return out;
}

function isToolResultOnly(message: CanonicalMessage): boolean {
  if (message.content.length === 0) return false;
  return message.content.every(
    (block) =>
      block.type === "tool_result" ||
      block.type === "tool_result_reference" ||
      (block.type === "media_reference" && typeof block.toolCallId === "string" && block.toolCallId.length > 0),
  );
}
