import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ContextPanel from './ContextPanel';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string>) =>
  key === 'context.cacheCounts' ? `Read ${values?.read} / input ${values?.input} tokens` : key }) }));

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
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('45');
  expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('45%');
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
  expect(screen.queryByRole('meter')).toBeNull();
});

it('clamps an overflowing budget and preserves zero category estimates', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 300000 } }) });
  const { container } = render(<ContextPanel target={{ sessionId: 'full', projectPath: '/p' }} used={300000} total={262144} percent={114} percentLabel="100%+" />);
  await screen.findByText('~300K');
  expect(screen.getAllByText('~0')).toHaveLength(2);
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
  expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('100%+');
  expect(container.querySelector('.pd-context-bar-fill')?.children).toHaveLength(1);
});

const completedAt = '2026-09-01T00:01:00Z';
const turn = (values: Record<string, number>) => ({ turnId: 'r', completedAt, usage: values });
it.each([
  [{ inputTokens: 5000, cacheReadTokens: 5000, outputTokens: 20000 }, '50%', 'cacheHit', 'Read 5K / input 10K tokens'],
  [{ inputTokens: 0, cacheReadTokens: 9000, cacheWriteTokens: 1000 }, '90%', 'cacheHit', 'Read 9K / input 10K tokens'],
  [{ inputTokens: 0, cacheReadTokens: 10000, outputTokens: 20000 }, '100%', 'cacheHit', 'Read 10K / input 10K tokens'],
  [{ inputTokens: 10000, cacheReadTokens: 0 }, '0%', 'cacheMiss', 'Read 0 / input 10K tokens'],
  [{ inputTokens: 10000 }, '—', 'cacheUnreported', null],
] as const)('displays provider cache usage %j with the correct input denominator', async (values, percent, state, counts) => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ lastTurnUsage: turn(values) }) });
  const { container } = render(<ContextPanel target={{ sessionId: 's', projectPath: '/p' }} {...usage} />);
  await screen.findByText(`context.${state}`);
  expect(container.querySelector('.pd-context-cache-header strong')?.textContent).toBe(percent);
  if (counts) expect(screen.getByText(counts)).toBeTruthy();
});

it('updates an open panel on completion and retains newer usage over stale history and empty completions', async () => {
  let resolve!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<ContextPanel target={{ sessionId: 's', projectPath: '/p' }} {...usage} />);
  const complete = (sessionId: string, projectPath: string, lastTurnUsage: unknown) => act(() => {
    window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', { detail: { sessionId, projectPath, lastTurnUsage } }));
  });
  complete('other', '/p', turn({ inputTokens: 0, cacheReadTokens: 10000 }));
  complete('s', '/other', turn({ inputTokens: 0, cacheReadTokens: 10000 }));
  expect(screen.getByText('context.cacheEmpty')).toBeTruthy();
  complete('s', '/p', turn({ inputTokens: 5000, cacheReadTokens: 5000 }));
  expect(screen.getByText('50%')).toBeTruthy();
  await act(async () => resolve({ ok: true, json: async () => ({ lastTurnUsage: {
    ...turn({ inputTokens: 10000, cacheReadTokens: 0 }), completedAt: '2026-09-01T00:00:00Z',
  } }) }));
  complete('s', '/p', turn({}));
  expect(screen.getByText('50%')).toBeTruthy();
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ lastTurnUsage: null }) });
  view.rerender(<ContextPanel target={{ sessionId: 'other', projectPath: '/p' }} {...usage} />);
  await screen.findByText('context.cacheEmpty');
  expect(screen.queryByText('50%')).toBeNull();
  view.unmount();
  complete('other', '/p', turn({ inputTokens: 0, cacheReadTokens: 10000 }));
});
