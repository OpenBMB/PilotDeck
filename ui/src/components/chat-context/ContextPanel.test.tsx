import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ContextPanel from './ContextPanel';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { cleanup(); mocks.fetch.mockReset(); });
const breakdown = { systemTokens: 2200, toolsTokens: 10200, messageTokens: 65500 };
const result = () => ({ ok: true, json: async () => ({ contextBreakdown: breakdown }) });
const usage = { used: 117000, total: 262144, percent: 45, percentLabel: '45%' };

it('shows compact usage and three category estimates without the detailed inspector', async () => {
  mocks.fetch.mockResolvedValue(result());
  const view = render(<ContextPanel target={{ sessionId: 'session:1', projectPath: 'F:\\项目', sessionKind: 'background_task', relativeTranscriptPath: 'tasks/t.jsonl' }} {...usage} />);
  expect(screen.getByText('45%')).toBeTruthy();
  expect(screen.getByText('~117K / 262K')).toBeTruthy();
  await screen.findByText('~2.2K');
  expect(screen.getByText('~10.2K')).toBeTruthy();
  expect(screen.getByText('~65.5K')).toBeTruthy();
  expect(view.container.querySelectorAll('dt')).toHaveLength(3);
  expect(view.container.querySelectorAll('button, input, pre, details')).toHaveLength(0);
  const url = new URL(mocks.fetch.mock.calls[0][0], 'http://local');
  expect(url.pathname).toContain('session%3A1');
  expect(url.searchParams.get('projectPath')).toBe('F:\\项目');
  expect(url.searchParams.get('relativeTranscriptPath')).toBe('tasks/t.jsonl');
  expect(url.searchParams.get('includeModelContext')).toBe('summary');
});

it('aborts stale loads on session switch and retries when reported usage changes', async () => {
  let finish!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: false });
  const { rerender, container } = render(<ContextPanel target={{ sessionId: 'old', projectPath: '/p' }} {...usage} />);
  const oldSignal = mocks.fetch.mock.calls[0][1].signal;
  rerender(<ContextPanel target={{ sessionId: 'new', projectPath: '/p' }} {...usage} />);
  expect(oldSignal.aborted).toBe(true);
  await waitFor(() => expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('false'));
  await act(async () => { finish(result()); });
  expect(screen.queryByText('~2.2K')).toBeNull();
  expect([...container.querySelectorAll('dd')].map(row => row.textContent)).toEqual(['—', '—', '—']);
  expect(screen.queryByRole('alert')).toBeNull();
  mocks.fetch.mockResolvedValueOnce(result());
  rerender(<ContextPanel target={{ sessionId: 'new', projectPath: '/p' }} {...usage} used={118000} />);
  await screen.findByText('~2.2K');
});

it('uses a quiet unknown state before a session or budget exists', () => {
  const { container } = render(<ContextPanel used={0} total={0} percent={0} percentLabel="0%" />);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.getByText('— / —')).toBeTruthy();
  expect([...container.querySelectorAll('dd')].map(row => row.textContent)).toEqual(['—', '—', '—']);
});
