/** Shared by the model config parser and settings UI. No model-name inference. */
export const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = typeof THINKING_EFFORTS[number];
export const THINKING_FORMATS = ['provider', 'openai', 'thinking-type', 'qwen-cloud', 'qwen-local', 'anthropic', 'google', 'openrouter', 'server-default'] as const;
export type ThinkingFormat = typeof THINKING_FORMATS[number];
export type ModelThinkingSettings = {
  state: 'default' | 'enabled' | 'disabled';
  efforts: ThinkingEffort[];
  format: ThinkingFormat;
};

export function thinkingFormatsForProtocol(protocol: string): readonly ThinkingFormat[] {
  if (protocol === 'anthropic') return ['provider', 'anthropic', 'server-default'];
  if (protocol === 'google') return ['provider', 'google', 'server-default'];
  if (protocol === 'openai-responses') return ['provider', 'openai', 'server-default'];
  return ['provider', 'openai', 'thinking-type', 'qwen-cloud', 'qwen-local', 'openrouter', 'server-default'];
}

export function parseThinkingSettings(raw: unknown, protocol: string): ModelThinkingSettings | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Model thinking must be an object.');
  const { state = 'default', efforts = [], format = 'provider' } = raw as Record<string, unknown>;
  if (state !== 'default' && state !== 'enabled' && state !== 'disabled') throw new Error('thinking.state must be default, enabled or disabled.');
  if (!Array.isArray(efforts) || efforts.some(e => !THINKING_EFFORTS.includes(e as ThinkingEffort))) throw new Error('thinking.efforts must contain only low, medium, high, xhigh or max.');
  if (!thinkingFormatsForProtocol(protocol).includes(format as ThinkingFormat)) throw new Error('thinking.format must match the provider protocol.');
  return { state, efforts: THINKING_EFFORTS.filter(e => efforts.includes(e)), format: format as ThinkingFormat };
}
