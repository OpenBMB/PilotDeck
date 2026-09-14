import type { CanonicalMessage } from "../../model/index.js";

export type ContinuationKind =
  | "none"
  | "action"
  | "action_confirmation"
  | "acknowledgement";

export type ExplicitRiskTier = "complex" | "reasoning";

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
  /^(?:continue|proceed|go ahead|do it|carry on|resume|keep going|start|run|execute)(?:\s+(?:(?:with\s+)?(?:this|it|the\s+(?:task|project|plan|work))))?[.!?,\s]*$/i,
  /^(?:please\s+)?(?:continue|proceed|finish|complete|implement|apply|use|fix|retry|rerun)(?:\s+with)?\s+(?:the\s+)?(?:same|previous|earlier|last|above|first|second|third|fourth)(?:\s+(?:task|project|work|plan|approach|option|issue|problem|step|change|implementation))?[.!?,\s]*$/i,
  /^(?:继续|接着|往下)(?:做|处理|进行|完成)?(?:这个|该)?(?:任务|项目|工作|方案|步骤|部分)?[吧啊呀。！!，,\s]*$/,
  /^(?:开始|执行|开搞)[吧啊呀。！!，,\s]*$/,
  /^(?:再|重新)(?:试|跑|执行|做)(?:一次|一遍)?[吧啊呀。！!，,\s]*$/,
  /^按(?:照)?(?:刚才|之前|上面|上述|前面)(?:的)?(?:要求|方案|计划|步骤)(?:继续|执行|处理|做|做完|完成|实现)?[吧啊呀。！!，,\s]*$/,
  /^(?:把|将)?(?:刚才|之前|上面|上述|前面|那个|这个|第一(?:个)?|第二(?:个)?|第三(?:个)?|第四(?:个)?|第[1-9]\d*个)(?:的)?(?:那个|这个)?(?:问题|错误|方案|计划|要求|任务|步骤|实现|修改|工作)?(?:继续|完成|做完|实现|修复|处理|执行|改完|跑完|解决)(?:掉|好|完)?[吧啊呀。！!，,\s]*$/,
  /^(?:继续)?(?:修复|完成|实现|处理|执行|解决)(?:刚才|之前|上面|上述|前面)(?:的)?(?:那个|这个)?(?:问题|错误|方案|计划|要求|任务|步骤|实现|修改|工作)[吧啊呀。！!，,\s]*$/,
];

const NEW_TASK_PATTERNS = [
  /(新任务|新项目|新问题|换个问题|换一个问题|另外|顺便|不做这个了|忽略之前|重新开始一个)/i,
  /\b(new task|new question|different question|unrelated|by the way|instead|ignore (?:the )?previous)\b/i,
];

const ASSISTANT_ACTION_PATTERN =
  /(是否|要不要|需要我|让我|我可以|请确认).{0,30}(开始|继续|执行|修改|运行|测试|提交|部署)|(?:shall|should|may|would you like me to).{0,40}(start|continue|proceed|run|execute|implement|test|commit|deploy)/i;

const EXPLICIT_COMPLEX_PATTERNS = [
  /(?:并行|同时).{0,24}(?:委派|分配|调用).{0,16}(?:子智能体|智能体|agent)/i,
  /(?:多个|多名|两个|三个|四个|[2-9]\s*个?).{0,12}(?:子智能体|subagents?|agents?).{0,20}(?:并行|委派|分工)/i,
  /(?:parallel(?:ly)?).{0,24}(?:delegate|dispatch|assign).{0,20}(?:subagents?|agents?)/i,
  /(?:orchestrat\w*).{0,20}(?:multiple|parallel).{0,16}(?:subagents?|agents?)/i,
];

const EXPLICIT_REASONING_PATTERNS = [
  /(?:整个|完整|全量|全部).{0,12}(?:仓库|代码库|项目代码)/i,
  /(?:多个|多份|多处|批量).{0,8}(?:文件|模块).{0,20}(?:分析|修改|重构|迁移|检查|测试)/i,
  /(?:分析|修改|重构|迁移|检查).{0,20}(?:多个|多份|多处|批量).{0,8}(?:文件|模块)/i,
  /跨(?:多个)?(?:文件|模块|组件)/i,
  /(?:entire|whole|full).{0,12}(?:repository|repo|codebase)/i,
  /(?:multi[- ]file|cross[- ]module).{0,24}(?:analysis|change|edit|refactor|migration|test)/i,
  /(?:analy[sz]e|modify|refactor|migrate).{0,24}(?:multiple|several).{0,12}(?:files|modules)/i,
  /(?:compare|review|survey|analy[sz]e).{0,32}(?:two|three|four|five|six|seven|eight|nine|ten|multiple|several|[2-9]\d*)[^.!?\n]{0,24}(?:papers?|studies|publications).{0,48}(?:cited|technical|research|literature).{0,16}(?:report|review|analysis)/i,
  /(?:比较|对比|综述|调研|分析).{0,24}(?:两|三|四|五|六|七|八|九|十|多|[2-9]\d*)篇?.{0,12}(?:论文|文献).{0,36}(?:引用|技术|研究|文献)(?:报告|综述|分析)/i,
];

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

export function detectExplicitRiskTier(message: string): ExplicitRiskTier | undefined {
  const normalized = normalize(message);
  if (EXPLICIT_REASONING_PATTERNS.some((pattern) => pattern.test(normalized))) return "reasoning";
  if (EXPLICIT_COMPLEX_PATTERNS.some((pattern) => pattern.test(normalized))) return "complex";
  return undefined;
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
