import { Brain, Zap, Sparkles, Atom } from 'lucide-react';

export const thinkingModes = [
  {
    id: 'none',
    name: 'Standard',
    description: 'Regular response',
    labelKey: 'chat:thinkingModes.standard.name',
    descKey: 'chat:thinkingModes.standard.description',
    icon: null,
    prefix: '',
    color: 'text-gray-600'
  },
  {
    id: 'think',
    name: 'Think',
    description: 'Basic extended thinking',
    labelKey: 'chat:thinkingModes.think.name',
    descKey: 'chat:thinkingModes.think.description',
    icon: Brain,
    prefix: 'think',
    color: 'text-blue-600'
  },
  {
    id: 'think-hard',
    name: 'Think Hard',
    description: 'More thorough evaluation',
    labelKey: 'chat:thinkingModes.thinkHard.name',
    descKey: 'chat:thinkingModes.thinkHard.description',
    icon: Zap,
    prefix: 'think hard',
    color: 'text-purple-600'
  },
  {
    id: 'think-harder',
    name: 'Think Harder',
    description: 'Deep analysis with alternatives',
    labelKey: 'chat:thinkingModes.thinkHarder.name',
    descKey: 'chat:thinkingModes.thinkHarder.description',
    icon: Sparkles,
    prefix: 'think harder',
    color: 'text-indigo-600'
  },
  {
    id: 'ultrathink',
    name: 'Ultrathink',
    description: 'Maximum thinking budget',
    labelKey: 'chat:thinkingModes.ultrathink.name',
    descKey: 'chat:thinkingModes.ultrathink.description',
    icon: Atom,
    prefix: 'ultrathink',
    color: 'text-red-600'
  }
];