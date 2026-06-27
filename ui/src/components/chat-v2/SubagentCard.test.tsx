// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import SubagentCard from './SubagentCard';

afterEach(() => {
  cleanup();
});

const makeSubagentMessage = (subagentId?: string): ChatMessage => ({
  id: 'subagent-card',
  type: 'assistant',
  content: '',
  timestamp: new Date().toISOString(),
  isToolUse: true,
  toolName: 'Task',
  toolInput: JSON.stringify({
    subagent_type: 'reviewer',
    description: 'Review the composer flow',
  }),
  ...(subagentId ? { subagentId } : {}),
});

describe('SubagentCard accessibility', () => {
  it('names clickable cards by their detail target and opens with keyboard activation', () => {
    const onOpenDetail = vi.fn();
    render(
      <SubagentCard
        message={makeSubagentMessage('subagent-123456789')}
        onOpenDetail={onOpenDetail}
        isSessionRunning
      />,
    );

    const card = screen.getByRole('button', {
      name: 'Open subagent details: Review the composer flow',
    });
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });

    expect(card.getAttribute('title')).toBe('Open subagent details: Review the composer flow');

    card.dispatchEvent(spaceEvent);
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(spaceEvent.defaultPrevented).toBe(true);
    expect(onOpenDetail).toHaveBeenCalledTimes(2);
    expect(onOpenDetail).toHaveBeenNthCalledWith(1, 'subagent-123456789');
    expect(onOpenDetail).toHaveBeenNthCalledWith(2, 'subagent-123456789');
  });

  it('does not expose a disabled detail button before the subagent id exists', () => {
    render(
      <SubagentCard
        message={makeSubagentMessage()}
        onOpenDetail={vi.fn()}
        isSessionRunning
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Review the composer flow')).toBeTruthy();
  });
});
