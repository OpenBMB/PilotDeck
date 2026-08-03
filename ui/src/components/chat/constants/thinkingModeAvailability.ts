import { thinkingModes, type ThinkingModeId } from './thinkingModes';

export type ThinkingModelContext = {
  providerId?: string;
  providerUrl?: string;
  protocol?: string;
  modelId?: string;
  supportsThinking?: boolean;
};

export type ThinkingModeAvailability = Record<ThinkingModeId, string | null>;

const ALL_MODES = thinkingModes.map((mode) => mode.id);

function allowOnly(allowed: ThinkingModeId[], reason: string): ThinkingModeAvailability {
  const allowedSet = new Set<ThinkingModeId>(['default', ...allowed]);
  return Object.fromEntries(
    ALL_MODES.map((mode) => [mode, allowedSet.has(mode) ? null : reason]),
  ) as ThinkingModeAvailability;
}

export function getThinkingModeAvailability(context?: ThinkingModelContext | null): ThinkingModeAvailability {
  const unsupportedReason = 'This thinking mode is not supported by the current model.';
  if (context?.supportsThinking === false) {
    return allowOnly([], unsupportedReason);
  }

  const providerId = (context?.providerId ?? '').toLowerCase();
  const providerUrl = (context?.providerUrl ?? '').toLowerCase();
  const protocol = (context?.protocol ?? '').toLowerCase();
  const modelId = (context?.modelId ?? '').toLowerCase();
  const fingerprint = `${providerId} ${providerUrl} ${modelId}`;

  if (protocol === 'openai-responses' || /(^|[^a-z])openai([^a-z]|$)|api\.openai\.com/.test(`${providerId} ${providerUrl}`)) {
    if (modelId.includes('gpt-5.5-pro')) return allowOnly(['medium', 'high', 'xhigh'], unsupportedReason);
    if (modelId.includes('gpt-5.5')) return allowOnly(['off', 'low', 'medium', 'high', 'xhigh'], unsupportedReason);
    if (modelId.includes('gpt-5')) return allowOnly(['minimal', 'low', 'medium', 'high'], unsupportedReason);
    if (/^(?:o1|o3|o4)(?:\b|[-_])/.test(modelId)) return allowOnly(['low', 'medium', 'high'], unsupportedReason);
  }

  if (protocol === 'google' || /google|gemini|generativelanguage/.test(fingerprint)) {
    if (/gemini-?3|gemini.*3\./.test(modelId)) return allowOnly(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
    if (/gemini-?2\.5|gemini.*2\.5/.test(modelId)) return allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  }

  if (/zhipu|bigmodel|z\.ai|z-ai|glm/.test(fingerprint)) {
    return /glm-?5\.2|glm.*5\.2/.test(modelId)
      ? allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason)
      : allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  }

  if (/qwen|dashscope|aliyun|alibaba|tongyi/.test(fingerprint)) {
    const thinkingOnly = /thinking|qwq|qvq/.test(modelId) && !/hybrid/.test(modelId);
    return thinkingOnly
      ? allowOnly(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason)
      : allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  }

  if (/deepseek/.test(fingerprint)) return allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  if (/kimi|moonshot/.test(fingerprint)) {
    if (/kimi-k3|kimi-k2\.7-code/.test(modelId)) {
      return allowOnly(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
    }
    if (/moonshot-v1/.test(modelId)) {
      return allowOnly(['off'], unsupportedReason);
    }
    return allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  }
  if (/minimax/.test(fingerprint)) return allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
  if (protocol === 'anthropic' || /anthropic|claude/.test(fingerprint)) return allowOnly(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);

  return allowOnly(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], unsupportedReason);
}

export function getEffectiveThinkingMode(
  mode: ThinkingModeId,
  availability: ThinkingModeAvailability,
): ThinkingModeId {
  return availability[mode] ? 'default' : mode;
}
