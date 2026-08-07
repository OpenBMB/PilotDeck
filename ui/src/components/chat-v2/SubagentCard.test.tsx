// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import SubagentCard from './SubagentCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; toolName?: string }) => {
      const messages: Record<string, string> = {
        'subagent.defaultDescription': '执行任务',
        'subagent.status.failed': '执行失败',
        'subagent.status.completed': '已完成',
        'subagent.status.stopped': '已停止',
        'subagent.status.thinking': '思考中',
      };
      return messages[key] || options?.defaultValue || key;
    },
  }),
}));

afterEach(cleanup);

function createSubagentMessage(): ChatMessage {
  return {
    id: 'subagent-container',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    isSubagentContainer: true,
    subagentId: 'subagent-1',
    toolInput: JSON.stringify({ subagent_type: 'general-purpose', description: '采集任务' }),
  };
}

describe('SubagentCard', () => {
  it('keeps an unfinished subagent thinking while parent activity is being synchronized', () => {
    render(<SubagentCard message={createSubagentMessage()} isSessionRunning={false} />);

    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.queryByText('已停止')).toBeNull();
  });

  it('keeps a live subagent running even before the parent session status arrives', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        isSessionRunning={false}
        liveActivity={{
          id: 'subagent:subagent-1',
          type: 'system',
          timestamp: new Date().toISOString(),
          isAgentActivity: true,
          state: 'running',
          detail: '正在采集',
        }}
      />,
    );

    expect(screen.getByText('正在采集')).toBeTruthy();
    expect(screen.queryByText('已停止')).toBeNull();
  });

  it('shows stopped after the session receives a confirmed abort event', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        isSessionRunning={false}
        liveActivity={{
          id: 'subagent:subagent-1',
          type: 'system',
          timestamp: new Date().toISOString(),
          isAgentActivity: true,
          state: 'cancelled',
        }}
      />,
    );

    expect(screen.getByText('已停止')).toBeTruthy();
    expect(screen.queryByText('思考中')).toBeNull();
  });
});
