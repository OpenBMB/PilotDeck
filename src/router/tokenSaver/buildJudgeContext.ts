import type { CanonicalMessage } from "../../model/index.js";

export type ContinuationKind =
  | "none"
  | "action"
  | "action_confirmation"
  | "acknowledgement";

export type JudgeContextFeatures = {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  failedToolResultCount: number;
  mediaCount: number;
  textCharacterCount: number;
  availableToolCount: number;
};

export type JudgeContext = {
  currentUserMessage: string;
  previousTaskMessage?: string;
  previousAssistantTail?: string;
  previousTier?: string;
  continuationKind: ContinuationKind;
  hasNewTaskSignal: boolean;
  features: JudgeContextFeatures;
};

export type JudgeContextOptions = {
  maxCurrentMessageChars: number;
  maxPreviousTaskChars: number;
  maxAssistantTailChars: number;
};

export const DEFAULT_JUDGE_CONTEXT_OPTIONS: JudgeContextOptions = {
  maxCurrentMessageChars: 2_000,
  maxPreviousTaskChars: 800,
  maxAssistantTailChars: 400,
};

const ACKNOWLEDGEMENT_PATTERN =
  /^(ok(?:ay)?|yes|y|sure|fine|got it|sounds good|好|好的|可以|行|嗯|对|是的|没问题|知道了|明白了|收到|来吧|冲|走)[.!。！,，?？\s]*$/i;

const ACTION_CONTINUATION_PATTERNS = [
  /^(?:continue|proceed|go ahead|do it|carry on|resume|keep going|start|run|execute)(?:\s+(?:this|it|the\s+(?:task|project|plan|work)))?[.!?,\s]*$/i,
  /^(?:继续|接着|往下)(?:做|处理|进行|完成)?(?:这个|该)?(?:任务|项目|工作|方案|步骤|部分)?[吧啊呀。！!，,\s]*$/,
  /^(?:开始|执行|开搞)[吧啊呀。！!，,\s]*$/,
  /^按照(?:刚才|之前|上面)(?:的)?(?:方案|计划)(?:继续|执行|处理|做)?[吧啊呀。！!，,\s]*$/,
];

const NEW_TASK_PATTERNS = [
  /(新任务|新项目|新问题|换个问题|换一个问题|另外|顺便|不做这个了|忽略之前|重新开始一个)/i,
  /\b(new task|new question|different question|unrelated|by the way|instead|ignore (?:the )?previous)\b/i,
];

const ASSISTANT_ACTION_PATTERN =
  /(是否|要不要|需要我|让我|我可以|请确认).{0,30}(开始|继续|执行|修改|运行|测试|提交|部署)|(?:shall|should|may|would you like me to).{0,40}(start|continue|proceed|run|execute|implement|test|commit|deploy)/i;

export function buildJudgeContext(input: {
  messages: CanonicalMessage[];
  previousTier?: string;
  availableToolCount?: number;
  options?: Partial<JudgeContextOptions>;
}): JudgeContext | undefined {
  const options = { ...DEFAULT_JUDGE_CONTEXT_OPTIONS, ...input.options };
  const currentIndex = findLastUserTextIndex(input.messages);
  if (currentIndex < 0) return undefined;

  const currentRaw = textFromMessage(input.messages[currentIndex]!);
  if (!currentRaw) return undefined;

  const previousAssistantRaw = findPreviousRoleText(input.messages, currentIndex, "assistant");
  const previousTaskRaw = findPreviousTaskMessage(input.messages, currentIndex);
  const hasNewTaskSignal = containsNewTaskSignal(currentRaw);
  const continuationKind = classifyContinuation(currentRaw, previousAssistantRaw, hasNewTaskSignal);

  return {
    currentUserMessage: truncateMiddle(currentRaw, options.maxCurrentMessageChars),
    ...(previousTaskRaw
      ? { previousTaskMessage: truncateMiddle(previousTaskRaw, options.maxPreviousTaskChars) }
      : {}),
    ...(previousAssistantRaw
      ? { previousAssistantTail: truncateTail(previousAssistantRaw, options.maxAssistantTailChars) }
      : {}),
    ...(input.previousTier ? { previousTier: input.previousTier } : {}),
    continuationKind,
    hasNewTaskSignal,
    features: collectFeatures(input.messages, input.availableToolCount ?? 0),
  };
}

export function isShortContinuation(message: string): boolean {
  return !containsNewTaskSignal(message) && looksLikeActionContinuation(message);
}

export function containsNewTaskSignal(message: string): boolean {
  const normalized = normalize(message);
  return NEW_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyContinuation(
  currentMessage: string,
  previousAssistantMessage: string | undefined,
  hasNewTaskSignal: boolean,
): ContinuationKind {
  if (hasNewTaskSignal) return "none";
  if (looksLikeActionContinuation(currentMessage)) return "action";
  if (!ACKNOWLEDGEMENT_PATTERN.test(normalize(currentMessage))) return "none";
  if (previousAssistantMessage && ASSISTANT_ACTION_PATTERN.test(previousAssistantMessage)) {
    return "action_confirmation";
  }
  return "acknowledgement";
}

function looksLikeActionContinuation(message: string): boolean {
  const normalized = normalize(message);
  if (normalized.length === 0 || normalized.length > 160) return false;
  return ACTION_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findLastUserTextIndex(messages: CanonicalMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.metadata?.synthetic) continue;
    if (textFromMessage(message)) return index;
  }
  return -1;
}

function findPreviousTaskMessage(messages: CanonicalMessage[], beforeIndex: number): string | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.metadata?.synthetic) continue;
    const text = textFromMessage(message);
    if (!text) continue;
    const normalized = normalize(text);
    if (ACKNOWLEDGEMENT_PATTERN.test(normalized) || looksLikeActionContinuation(normalized)) continue;
    return text;
  }
  return undefined;
}

function findPreviousRoleText(
  messages: CanonicalMessage[],
  beforeIndex: number,
  role: CanonicalMessage["role"],
): string | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== role || message.metadata?.synthetic) continue;
    const text = textFromMessage(message);
    if (text) return text;
  }
  return undefined;
}

function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function collectFeatures(messages: CanonicalMessage[], availableToolCount: number): JudgeContextFeatures {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let failedToolResultCount = 0;
  let mediaCount = 0;
  let textCharacterCount = 0;

  for (const message of messages) {
    if (!message.metadata?.synthetic) {
      if (message.role === "user") userMessageCount += 1;
      else assistantMessageCount += 1;
    }
    for (const block of message.content) {
      switch (block.type) {
        case "text":
        case "thinking":
          textCharacterCount += block.text.length;
          break;
        case "tool_call":
          toolCallCount += 1;
          break;
        case "tool_result":
          toolResultCount += 1;
          if (block.isError) failedToolResultCount += 1;
          for (const content of block.content) {
            if (content.type === "text") textCharacterCount += content.text.length;
            else mediaCount += 1;
          }
          break;
        case "tool_result_reference":
          toolResultCount += 1;
          if (block.isError) failedToolResultCount += 1;
          textCharacterCount += block.originalBytes;
          break;
        case "image":
        case "pdf":
        case "audio":
        case "media_reference":
          mediaCount += 1;
          break;
      }
    }
  }

  return {
    messageCount: messages.length,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    toolResultCount,
    failedToolResultCount,
    mediaCount,
    textCharacterCount,
    availableToolCount,
  };
}

function normalize(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.65);
  const tail = remaining - head;
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function truncateTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "...[truncated]...\n";
  if (maxChars <= marker.length) return value.slice(-maxChars);
  return `${marker}${value.slice(-(maxChars - marker.length))}`;
}
