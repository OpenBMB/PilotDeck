// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeliveryStatusPanel from './DeliveryStatusPanel';
import type { DeliveryResultView } from './deliveryStatus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number; checks?: string; review?: string }) => {
      const messages: Record<string, string> = {
        'subagent.delivery.title': '交付验收',
        'subagent.delivery.summaryLine': '程序检查 {{checks}} · 模型评审 {{review}}',
        'subagent.delivery.status.passedScoped': '已执行检查通过',
        'subagent.delivery.status.failed': '检查未通过',
        'subagent.delivery.status.skipped': '已跳过',
        'subagent.delivery.status.inconclusive': '证据不足',
        'subagent.delivery.status.error': '检查出错',
        'subagent.delivery.checkStatus.passed': '通过',
        'subagent.delivery.checkStatus.failed': '未通过',
        'subagent.delivery.checkStatus.skipped': '已跳过',
        'subagent.delivery.reviewStatus.accepted': '通过',
        'subagent.delivery.reviewStatus.skipped': '已跳过',
        'subagent.delivery.reviewNotRequested': '未请求',
        'subagent.delivery.noAttempts': '无尝试记录',
        'subagent.delivery.programChecks': '程序检查',
        'subagent.delivery.modelReview': '模型评审',
        'subagent.delivery.checkedCount': '{{count}} 项',
        'subagent.delivery.repairs': '修复次数',
        'subagent.delivery.producerTokens': '生成 {{count}} tokens',
        'subagent.delivery.reviewTokens': '评审 {{count}} tokens',
        'subagent.delivery.copyReceipt': '复制回执路径',
        'subagent.delivery.showHistory': '查看全部 {{count}} 次尝试',
        'subagent.delivery.hideHistory': '收起历史尝试',
      };
      const raw = messages[key] ?? options?.defaultValue ?? key;
      return raw
        .replace('{{count}}', String(options?.count ?? ''))
        .replace('{{checks}}', String(options?.checks ?? ''))
        .replace('{{review}}', String(options?.review ?? ''));
    },
  }),
}));

afterEach(cleanup);

const passed: DeliveryResultView = {
  status: 'passed',
  deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-2.json',
  repairs: 1,
  producerTotalTokens: 1200,
  attempts: [
    {
      attempt: 1,
      deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-1.json',
      checks: {
        status: 'failed',
        checked: 4,
        issues: [{ path: 'changes.0.file', code: 'file_missing', message: 'missing file' }],
      },
    },
    {
      attempt: 2,
      deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-2.json',
      checks: { status: 'passed', checked: 5, issues: [] },
      review: {
        status: 'accepted',
        summary: 'Report matches expectations.',
        issues: [],
        modelLabel: 'openai/gpt-test',
        durationMs: 3120,
        totalTokens: 250,
      },
    },
  ],
};

describe('DeliveryStatusPanel', () => {
  it('labels a passed result as scoped applicable-checks success, not blanket quality', () => {
    render(<DeliveryStatusPanel delivery={passed} />);
    expect(screen.getByText(/已执行检查通过/)).toBeTruthy();
    expect(screen.queryByText(/任务成功/)).toBeNull();
  });

  it('keeps the receipt path collapsed until expanded and hides history by default', () => {
    render(<DeliveryStatusPanel delivery={passed} />);
    expect(screen.queryByText(/attempt-2\.json/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/attempt-2\.json/)).toBeTruthy();
    // Latest attempt only: first attempt issue is behind the history toggle.
    expect(screen.queryByText(/missing file/)).toBeNull();
    expect(screen.getByText(/查看全部 2 次尝试/)).toBeTruthy();
  });

  it('shows program checks and model review separately with token counts', () => {
    render(<DeliveryStatusPanel delivery={passed} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getAllByText(/程序检查/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/模型评审/).length).toBeGreaterThan(0);
    expect(screen.getByText(/openai\/gpt-test/)).toBeTruthy();
    expect(screen.getByText(/评审 250 tokens/)).toBeTruthy();
    expect(screen.getByText(/生成 1200 tokens/)).toBeTruthy();
    expect(screen.getByText(/修复次数: 1/)).toBeTruthy();
  });

  it('shows the skipped review summary instead of implying acceptance', () => {
    const skippedReview: DeliveryResultView = {
      status: 'failed',
      deliveryFile: '.pilotdeck/deliveries/sub-2/attempt-1.json',
      repairs: 0,
      attempts: [
        {
          attempt: 1,
          deliveryFile: '.pilotdeck/deliveries/sub-2/attempt-1.json',
          checks: { status: 'failed', checked: 2, issues: [] },
          review: { status: 'skipped', summary: 'L1 checks failed; review skipped.', issues: [] },
        },
      ],
    };
    render(<DeliveryStatusPanel delivery={skippedReview} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText(/检查未通过/)).toBeTruthy();
    expect(screen.getAllByText(/已跳过/).length).toBeGreaterThan(0);
    expect(screen.getByText(/L1 checks failed; review skipped\./)).toBeTruthy();
  });

  it('renders inconclusive truncated payloads as amber, never green', () => {
    const inconclusive: DeliveryResultView = {
      status: 'inconclusive',
      deliveryFile: '',
      repairs: 0,
      attempts: [],
    };
    render(<DeliveryStatusPanel delivery={inconclusive} />);

    expect(screen.getByText(/证据不足/)).toBeTruthy();
    const summary = screen.getByRole('button', { expanded: false });
    expect(summary.querySelector('.text-green-500, .text-green-600')).toBeNull();
  });

  it('copies the receipt path to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DeliveryStatusPanel delivery={passed} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    fireEvent.click(screen.getByRole('button', { name: '复制回执路径' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('.pilotdeck/deliveries/sub-1/attempt-2.json'));
  });
});
