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
};

export type ProtectedContextMessageOptions = ProtectedContextOptions & {
  toolNamesByCallId?: ReadonlyMap<string, string>;
};

export type MessageTurn = {
  index: number;
  messages: CanonicalMessage[];
};

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
  return protectedIndexes;
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
