import type { CanonicalMessage } from "../../model/index.js";

export const DEFAULT_PROTECTED_TOOL_RESULT_NAMES: ReadonlySet<string> = new Set([
  "read_skill",
  "ReadSkill",
  "ask_user_question",
  "AskUserQuestion",
  "todo_write",
  "TodoWrite",
  "structured_output",
  "StructuredOutput",
  "agent",
  "Agent",
  "Task",
  "task_create",
  "TaskCreate",
  "task_list",
  "TaskList",
  "task_output",
  "TaskOutput",
  "task_wait",
  "TaskWait",
  "task_stop",
  "TaskStop",
]);

export type ProtectedContextOptions = {
  protectedToolNames?: Iterable<string>;
  /**
   * Keep only the newest protected turns when callers need a bounded context
   * projection. Undefined preserves the historical unbounded behavior.
   */
  maxProtectedTurns?: number;
};

export type ProtectedContextMessageOptions = ProtectedContextOptions & {
  toolNamesByCallId?: ReadonlyMap<string, string>;
};

export type MessageTurn = {
  index: number;
  messages: CanonicalMessage[];
};

export type AtomicMessageFrame = MessageTurn;

export function protectedToolNameSet(names?: Iterable<string>): ReadonlySet<string> {
  if (names === undefined) {
    return DEFAULT_PROTECTED_TOOL_RESULT_NAMES;
  }
  if (names instanceof Set) {
    return names;
  }
  return new Set(names);
}

export function collectToolNamesByCallId(messages: CanonicalMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_call") {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
}

export function splitMessagesIntoTurns(messages: CanonicalMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let current: CanonicalMessage[] = [];
  for (const message of messages) {
    const isUserStart = message.role === "user" && !isToolResultOnly(message);
    if (isUserStart && current.length > 0) {
      turns.push({ index: turns.length, messages: current });
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push({ index: turns.length, messages: current });
  }
  return turns;
}

/**
 * Split a long Agent trajectory into contiguous frames without separating a
 * tool call from its result. Unlike conversational turns, this remains useful
 * when one user prompt drives many assistant/tool-result iterations.
 */
export function splitMessagesIntoAtomicFrames(messages: CanonicalMessage[]): AtomicMessageFrame[] {
  const callIndexes = new Map<string, number>();
  const resultIndexes = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    for (const block of message.content) {
      if (block.type === "tool_call") {
        callIndexes.set(block.id, index);
      } else if (block.type === "tool_result" || block.type === "tool_result_reference") {
        resultIndexes.set(block.toolCallId, index);
      }
    }
  }

  const intervalEnds = new Map<number, number>();
  for (const [toolCallId, callIndex] of callIndexes) {
    const resultIndex = resultIndexes.get(toolCallId);
    if (resultIndex === undefined) continue;
    const start = Math.min(callIndex, resultIndex);
    const end = Math.max(callIndex, resultIndex);
    intervalEnds.set(start, Math.max(intervalEnds.get(start) ?? start, end));
  }

  const frames: AtomicMessageFrame[] = [];
  let start = 0;
  while (start < messages.length) {
    let end = Math.max(start, intervalEnds.get(start) ?? start);
    for (let cursor = start + 1; cursor <= end; cursor += 1) {
      end = Math.max(end, intervalEnds.get(cursor) ?? cursor);
    }
    frames.push({ index: frames.length, messages: messages.slice(start, end + 1) });
    start = end + 1;
  }
  return frames;
}

export function collectProtectedTurnIndexes(
  messages: CanonicalMessage[],
  options: ProtectedContextOptions = {},
): Set<number> {
  const toolNamesByCallId = collectToolNamesByCallId(messages);
  const protectedIndexes = new Set<number>();
  const turns = splitMessagesIntoTurns(messages);
  for (const turn of turns) {
    if (turn.messages.some((message) =>
      isProtectedContextMessage(message, {
        ...options,
        toolNamesByCallId,
      })
    )) {
      protectedIndexes.add(turn.index);
    }
  }
  if (options.maxProtectedTurns === undefined) {
    return protectedIndexes;
  }
  const limit = Math.max(0, Math.floor(options.maxProtectedTurns));
  if (limit === 0) {
    return new Set();
  }
  return new Set([...protectedIndexes].slice(-limit));
}

export function collectProtectedFrameIndexes(
  messages: CanonicalMessage[],
  options: ProtectedContextOptions = {},
): Set<number> {
  const toolNamesByCallId = collectToolNamesByCallId(messages);
  const protectedIndexes = new Set<number>();
  const frames = splitMessagesIntoAtomicFrames(messages);
  for (const frame of frames) {
    if (frame.messages.some((message) =>
      isProtectedContextMessage(message, {
        ...options,
        toolNamesByCallId,
      })
    )) {
      protectedIndexes.add(frame.index);
    }
  }
  if (options.maxProtectedTurns === undefined) {
    return protectedIndexes;
  }
  const limit = Math.max(0, Math.floor(options.maxProtectedTurns));
  if (limit === 0) {
    return new Set();
  }
  return new Set([...protectedIndexes].slice(-limit));
}

export function isProtectedContextMessage(
  message: CanonicalMessage,
  options: ProtectedContextMessageOptions = {},
): boolean {
  if (hasMemoryContext(message)) {
    return true;
  }

  const protectedNames = protectedToolNameSet(options.protectedToolNames);
  const toolNamesByCallId = options.toolNamesByCallId;
  for (const block of message.content) {
    if (block.type === "tool_call" && protectedNames.has(block.name)) {
      return true;
    }
    if ((block.type === "tool_result" || block.type === "tool_result_reference")
      && toolNamesByCallId
      && isProtectedToolCallId(block.toolCallId, toolNamesByCallId, protectedNames)
    ) {
      return true;
    }
  }
  return false;
}

export function isProtectedToolCallId(
  toolCallId: string,
  toolNamesByCallId: ReadonlyMap<string, string>,
  protectedToolNames?: Iterable<string>,
): boolean {
  const toolName = toolNamesByCallId.get(toolCallId);
  return toolName !== undefined && protectedToolNameSet(protectedToolNames).has(toolName);
}

function hasMemoryContext(message: CanonicalMessage): boolean {
  return message.content.some((block) =>
    block.type === "text" && block.text.trimStart().startsWith("<memory-context>")
  );
}

function isToolResultOnly(message: CanonicalMessage): boolean {
  if (message.content.length === 0) return false;
  return message.content.every(
    (block) => block.type === "tool_result" || block.type === "tool_result_reference",
  );
}
