import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import { buildRenderableMessageItems, getLiveProcessGroups, isPendingToolUseMessage } from './processGrouping';

const user: ChatMessage = { id: 'user', type: 'user', content: 'Start', timestamp: '2026-09-05' };
const tool = (id: string, finished = false): ChatMessage => ({
  id, type: 'assistant', content: '', isToolUse: true, toolId: id, toolName: 'web_fetch', timestamp: '2026-09-05',
  ...(finished ? { toolResult: { content: '', isError: false } } : {}),
});

describe('streaming process ownership', () => {
  it('accepts an empty successful result as completion', () => {
    expect(isPendingToolUseMessage(tool('done', true))).toBe(false);
    expect(getLiveProcessGroups([user, tool('done', true)], { isAssistantWorking: true })[0].isRunning).toBe(false);
  });

  it('keeps an earlier pending group running when a later group has completed', () => {
    const explanation: ChatMessage = { id: 'text', type: 'assistant', content: 'Other work', timestamp: '2026-09-05' };
    const groups = getLiveProcessGroups([user, tool('pending'), explanation, tool('done', true)], { isAssistantWorking: true });
    expect(groups.map((group) => group.isRunning)).toEqual([true, false]);
  });

  it('waits for every parallel invocation, including the earlier invocation', () => {
    expect(getLiveProcessGroups([user, tool('pending'), tool('done', true)], { isAssistantWorking: true })[0].isRunning).toBe(true);
    expect(getLiveProcessGroups([user, tool('pending', true), tool('done', true)], { isAssistantWorking: true })[0].isRunning).toBe(false);
  });

  it('keeps reasoning in the same row when a tool arrives and the run completes', () => {
    const thinking: ChatMessage = { id: 'thought', type: 'assistant', isThinking: true, isStreaming: true, content: 'Reasoning', timestamp: '2026-09-05' };
    const live = buildRenderableMessageItems([user, thinking], { isAssistantWorking: true });
    const afterTool = buildRenderableMessageItems([user, { ...thinking, isStreaming: false }, tool('done', true)], { isAssistantWorking: false });
    expect(live.some((item) => item.message.id === thinking.id)).toBe(true);
    expect(afterTool.some((item) => item.message.id === thinking.id)).toBe(true);
  });
});
