// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const DELIVERY_TOOL_RESULT = {
  content: '[general-purpose] 采集任务\n\nDone.\n\nDelivery file: .pilotdeck/deliveries/sub-9/attempt-1.json',
  isError: false,
  // Bridge-forwarded gateway `data` for the agent tool.
  toolUseResult: {
    subagentType: 'general-purpose',
    description: '采集任务',
    text: 'Done.',
    delivery_file: '.pilotdeck/deliveries/sub-9/attempt-1.json',
    delivery: {
      status: 'passed',
      deliveryFile: '.pilotdeck/deliveries/sub-9/attempt-1.json',
      repairs: 0,
      producerUsage: { totalTokens: 900 },
      attempts: [
        {
          attempt: 1,
          deliveryFile: '.pilotdeck/deliveries/sub-9/attempt-1.json',
          checks: { status: 'passed', checked: 3, issues: [] },
          review: {
            status: 'accepted',
            summary: 'Result matches the requested outline.',
            issues: [],
            model: { provider: 'openai', model: 'gpt-test' },
            durationMs: 2800,
          },
        },
      ],
    },
  },
};

describe('SubagentCard', () => {
  it('keeps an unfinished subagent thinking while parent activity is being synchronized', () => {
    render(<SubagentCard message={createSubagentMessage()} sessionRuntimeState="synchronizing" />);

    expect(screen.getByText('思考中')).toBeTruthy();
    expect(screen.queryByText('已停止')).toBeNull();
  });

  it('keeps a live subagent running even before the parent session status arrives', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        sessionRuntimeState="synchronizing"
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

  it('stops an unfinished subagent when the parent session is confirmed inactive', () => {
    render(<SubagentCard message={createSubagentMessage()} sessionRuntimeState="inactive" />);

    expect(screen.getByText('已停止')).toBeTruthy();
    expect(screen.queryByText('思考中')).toBeNull();
  });

  it('does not let a stale running activity override a confirmed inactive parent', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        sessionRuntimeState="inactive"
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

    expect(screen.getByText('已停止')).toBeTruthy();
    expect(screen.queryByText('思考中')).toBeNull();
    expect(screen.queryByText('正在采集')).toBeNull();
  });

  it('keeps an explicit completed activity completed after the parent becomes inactive', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        sessionRuntimeState="inactive"
        liveActivity={{
          id: 'subagent:subagent-1',
          type: 'system',
          timestamp: new Date().toISOString(),
          isAgentActivity: true,
          state: 'completed',
        }}
      />,
    );

    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByText('已停止')).toBeNull();
  });

  it('renders an explicit cancelled activity as stopped before refresh', () => {
    render(
      <SubagentCard
        message={createSubagentMessage()}
        sessionRuntimeState="running"
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
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.queryByText('思考中')).toBeNull();
  });

  it('shows the delivery receipt panel from the real tool result payload', () => {
    const message = { ...createSubagentMessage(), toolResult: DELIVERY_TOOL_RESULT };
    render(<SubagentCard message={message} sessionRuntimeState="synchronizing" />);

    const summary = screen.getByRole('button', { expanded: false });
    expect(summary.textContent).toContain('交付验收');
    expect(summary.textContent).toContain('已执行检查通过');
    // Hidden until the panel is expanded.
    expect(screen.queryByText(/attempt-1\.json/)).toBeNull();
  });

  it('does not render a delivery panel for results without delivery data', () => {
    const message = {
      ...createSubagentMessage(),
      toolResult: { content: 'plain text result', isError: false },
    };
    render(<SubagentCard message={message} sessionRuntimeState="synchronizing" />);

    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });
});


it('delivery controls do not open the child transcript', () => {
  const onOpenDetail=vi.fn();
  render(<SubagentCard message={{...createSubagentMessage(),toolResult:DELIVERY_TOOL_RESULT}} onOpenDetail={onOpenDetail} />);
  const toggle=screen.getByRole('button',{expanded:false});
  fireEvent.click(toggle);
  fireEvent.keyDown(toggle,{key:'Enter'});
  expect(onOpenDetail).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{expanded:true})).toBeTruthy();
});
