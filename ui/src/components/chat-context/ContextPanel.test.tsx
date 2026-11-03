import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ContextPanel from './ContextPanel';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); mocks.fetch.mockReset(); });
const snapshot = { capturedAt: '2026-11-03T09:00:00Z', provider: 'test', model: 'm',
  systemPrompt: '<system>actual assembled prompt</system>', tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'original user input' }] }],
  breakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 300 } };
const result = (modelContext = snapshot) => ({ ok: true, json: async () => ({ modelContext }) });

it('loads actual context on demand and exposes searchable system, tool schemas and message payloads', async () => {
  mocks.fetch.mockResolvedValue(result());
  render(<ContextPanel target={{ sessionId: 'session:1', projectPath: 'F:\\项目', sessionKind: 'background_task', relativeTranscriptPath: 'tasks/t.jsonl' }} used={600} total={1200} />);
  await waitFor(() => expect(screen.getByText('~100')).toBeTruthy());
  const url = new URL(mocks.fetch.mock.calls[0][0], 'http://local');
  expect(url.pathname).toContain('session%3A1');
  expect(url.searchParams.get('projectPath')).toBe('F:\\项目');
  expect(url.searchParams.get('relativeTranscriptPath')).toBe('tasks/t.jsonl');
  expect(url.searchParams.get('includeModelContext')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'context.inspect' }));
  expect(screen.getByText(snapshot.systemPrompt)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /context.tools/ }));
  expect(screen.getByText('read_file')).toBeTruthy();
  expect(screen.getByText(/"inputSchema"/)).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: /context.messages/ }));
  expect(screen.getByText('1 · user')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-match' } });
  expect(screen.getByText('context.noResults')).toBeTruthy();
});

it('aborts stale loads on session switch and allows retry after an HTTP failure', async () => {
  let finish!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ok: false });
  const { rerender } = render(<ContextPanel target={{ sessionId: 'old', projectPath: '/p' }} used={0} total={0} />);
  const oldSignal = mocks.fetch.mock.calls[0][1].signal;
  rerender(<ContextPanel target={{ sessionId: 'new', projectPath: '/p' }} used={0} total={0} />);
  expect(oldSignal.aborted).toBe(true);
  await screen.findByRole('alert');
  await act(async () => { finish(result()); });
  expect(screen.queryByText('~100')).toBeNull();
  mocks.fetch.mockResolvedValueOnce(result());
  fireEvent.click(screen.getByRole('button', { name: 'context.refresh' }));
  await screen.findByText('~100');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('offers a clear empty state before a session exists', () => {
  render(<ContextPanel used={0} total={0} />);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.getByText('context.empty')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'context.inspect' }) as HTMLButtonElement).disabled).toBe(true);
});
