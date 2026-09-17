import type { CanonicalModelRequest, CanonicalThinkingConfig, ModelDefinition, ProviderConfig } from '../protocol/canonical.js';
import { ModelRequestError } from '../protocol/errors.js';
import { THINKING_EFFORTS, type ThinkingEffort, type ThinkingFormat } from './settings.js';

export type ThinkingMode = NonNullable<CanonicalThinkingConfig['mode']>;
export type ThinkingPlan = {
  mode: ThinkingMode;
  enabled: boolean;
  bodyPatch?: Record<string, unknown>;
  thinkingType?: 'adaptive' | 'disabled';
  effort?: ThinkingEffort | 'none';
  useAnthropicOutputEffort?: boolean;
  useOpenAIReasoning?: boolean;
  thinkingLevel?: ThinkingEffort;
  unsupportedReason?: string;
};

/** Legacy off/minimal/budget settings no longer control model reasoning. */
export function normalizeThinkingMode(thinking?: CanonicalThinkingConfig): ThinkingMode {
  return THINKING_EFFORTS.includes(thinking?.mode as ThinkingEffort) ? thinking!.mode! : 'default';
}

function resolveFormat(provider: ProviderConfig, format: ThinkingFormat): ThinkingFormat {
  if (format !== 'provider') return format;
  if (provider.protocol === 'anthropic') return 'anthropic';
  if (provider.protocol === 'google') return 'google';
  if (provider.protocol === 'openai-responses') return 'openai';
  // Endpoint presets, never the model's name: proxies may translate native APIs.
  const preset: Record<string, ThinkingFormat> = {
    openai: 'openai', dashscope: 'qwen-cloud', deepseek: 'thinking-type',
    moonshot: 'thinking-type', zhipu: 'thinking-type', openrouter: 'openrouter',
    ollama: 'server-default', minimax: 'server-default', volc_ark: 'server-default',
  };
  return preset[provider.id] ?? 'openai';
}

export function resolveThinkingPlan(
  requestThinking: CanonicalThinkingConfig | undefined,
  provider: ProviderConfig,
  model: ModelDefinition,
): ThinkingPlan {
  const settings = model.thinking;
  const state = settings?.state ?? 'default';
  // Model state always wins over stale conversation/agent preferences.
  if (state === 'default') return { mode: 'default', enabled: false };
  const off = state === 'disabled';
  const mode = off ? 'off' : normalizeThinkingMode(requestThinking);
  const plan: ThinkingPlan = { mode, enabled: !off };
  const fail = (message: string): ThinkingPlan => ({ ...plan, unsupportedReason: `${model.id}: ${message}` });
  const effort = mode !== 'default' && mode !== 'off' ? mode as ThinkingEffort : undefined;
  if (effort && !settings?.efforts.includes(effort)) return fail(`Reasoning effort '${effort}' is not configured. Select Default or configure the model's supported efforts.`);
  const format = resolveFormat(provider, settings?.format ?? 'provider');
  if (format === 'server-default') {
    if (off || effort) return fail('This parameter format only supports the server default. Choose a thinking parameter format in model settings.');
    return { mode, enabled: false };
  }
  if (format === 'openai') {
    return { ...plan, effort: off ? 'none' : effort, useOpenAIReasoning: true };
  }
  if (format === 'anthropic') {
    if (off) return { ...plan, thinkingType: 'disabled' };
    // Older extended-thinking models require a token budget, which we do not generate.
    const budgetOnly = /claude-(?:3|haiku-3|haiku-4|(?:sonnet|opus)-4(?:[.-][0-5](?:\D|$)|-20|$))/.test(model.id);
    if (budgetOnly) return effort ? fail('This model requires a thinking budget; only Default is supported.') : { mode, enabled: false };
    return { ...plan, thinkingType: 'adaptive', effort, useAnthropicOutputEffort: true };
  }
  if (format === 'google') {
    if (off) return fail('Turning off thinking is not supported by this effort-only Gemini adapter. Uncheck both thinking options to use the server default.');
    if (!/gemini-?3/.test(model.id)) return effort ? fail('This Gemini model has no supported thinking-level adapter. Select Default.') : { mode, enabled: false };
    if (effort && !['low', 'medium', 'high'].includes(effort)) return fail(`Gemini thinkingLevel does not support '${effort}'.`);
    return { ...plan, thinkingLevel: effort };
  }
  const effortPatch = effort ? { reasoning_effort: effort } : {};
  // These official endpoint versions are always-thinking. Do not emit a fake switch.
  if (settings?.format === 'provider' && ((provider.id === 'moonshot' && /^kimi-k3/.test(model.id)) ||
      (provider.id === 'zhipu' && /^glm-?5\.3/.test(model.id)))) {
    if (off) return fail('This model cannot disable thinking. Uncheck both options to use the server default.');
    return { ...plan, bodyPatch: effortPatch };
  }

  if (format === 'qwen-cloud') return { ...plan, bodyPatch: { enable_thinking: !off, ...effortPatch } };
  if (format === 'qwen-local') return { ...plan, bodyPatch: { chat_template_kwargs: { enable_thinking: !off }, ...effortPatch } };
  if (format === 'openrouter') return { ...plan, bodyPatch: { reasoning: off ? { enabled: false } : { enabled: true, ...(effort ? { effort } : {}) } } };
  return { ...plan, bodyPatch: { thinking: { type: off ? 'disabled' : 'enabled' }, ...effortPatch } };
}

export function throwIfUnsupportedThinkingPlan(plan: ThinkingPlan, request: CanonicalModelRequest): void {
  if (!plan.unsupportedReason) return;
  throw new ModelRequestError('unsupported_thinking', plan.unsupportedReason, {
    provider: request.provider, model: request.model, thinkingMode: plan.mode,
  });
}
