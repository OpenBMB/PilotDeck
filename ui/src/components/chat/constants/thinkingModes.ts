import { Atom, Brain, Sparkles, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type ThinkingModeId = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThinkingModeOption = {
  id: ThinkingModeId;
  name: string;
  description: string;
  icon: LucideIcon | null;
  color: string;
};

export const thinkingModes: ThinkingModeOption[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Use the model/provider default',
    icon: null,
    color: 'text-neutral-600',
  },
  {
    id: 'low',
    name: 'Low',
    description: 'Light reasoning effort',
    icon: Brain,
    color: 'text-blue-600',
  },
  {
    id: 'medium',
    name: 'Medium',
    description: 'Balanced reasoning effort',
    icon: Zap,
    color: 'text-purple-600',
  },
  {
    id: 'high',
    name: 'High',
    description: 'Deeper reasoning for harder tasks',
    icon: Sparkles,
    color: 'text-indigo-600',
  },
  {
    id: 'xhigh',
    name: 'Xhigh',
    description: 'Maximum effort for supported models',
    icon: Atom,
    color: 'text-red-600',
  },
  {
    id: 'max',
    name: 'Max',
    description: 'Provider maximum reasoning mode',
    icon: Atom,
    color: 'text-red-700',
  },
];

export function isThinkingModeId(value: unknown): value is ThinkingModeId {
  return typeof value === 'string' && thinkingModes.some((mode) => mode.id === value);
}

export function thinkingModeToConfig(mode: ThinkingModeId) {
  return {
    mode,
    enabled: mode !== 'default',
  };
}
