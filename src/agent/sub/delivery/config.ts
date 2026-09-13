import type { DeliveryRuntimeConfig } from './types.js';

export function deliveryConfig(value?: Partial<DeliveryRuntimeConfig>): DeliveryRuntimeConfig {
  const config: DeliveryRuntimeConfig = {
    mode: value?.mode ?? 'auto',
    ...(value?.prompt !== undefined ? { prompt: value.prompt } : {}),
    maxRepairs: value?.maxRepairs ?? 2,
    maxTurns: value?.maxTurns ?? 20,
    ...(value?.reviewerModel ? { reviewerModel: value.reviewerModel } : {}),
    reviewTimeoutMs: value?.reviewTimeoutMs ?? 60_000,
    maxReviewInputTokens: value?.maxReviewInputTokens ?? 4096,
    maxReviewOutputTokens: value?.maxReviewOutputTokens ?? 512,
  };
  if (!['auto', 'off'].includes(config.mode)) throw new Error('Delivery mode must be auto or off.');
  if (config.prompt !== undefined && (typeof config.prompt !== 'string' || Buffer.byteLength(config.prompt) > 32768)) throw new Error('Delivery prompt must be a string up to 32768 bytes.');
  const bounds = { maxRepairs: [0, 5], maxTurns: [1, 100], reviewTimeoutMs: [1000, 180000], maxReviewInputTokens: [256, 16384], maxReviewOutputTokens: [64, 2048] } as const;
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const [min, max] = bounds[key];
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid delivery ${key}: expected an integer from ${min} to ${max}.`);
  }
  if (config.reviewerModel && [config.reviewerModel.provider, config.reviewerModel.model].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Delivery reviewer requires a provider and model.');
  return config;
}
