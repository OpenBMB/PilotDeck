import { thinkingModes, type ThinkingModeId } from './thinkingModes';
export type ThinkingModelContext = {
  providerId?: string; providerUrl?: string; protocol?: string; modelId?: string;
  supportsThinking?: boolean;
  thinking?: { state?: string; efforts?: string[] };
};
export type ThinkingModeAvailability = Record<ThinkingModeId, string | null>;
export function getThinkingModeAvailability(context?: ThinkingModelContext | null): ThinkingModeAvailability {
  return Object.fromEntries(thinkingModes.map(({ id }) => [id,
    id === 'default' || (context?.thinking?.state === 'enabled' && context.thinking.efforts?.includes(id))
      ? null : 'This reasoning effort is not configured for the current model.',
  ])) as ThinkingModeAvailability;
}
export function getEffectiveThinkingMode(mode: ThinkingModeId, availability: ThinkingModeAvailability): ThinkingModeId {
  return availability[mode] === null ? mode : 'default';
}
