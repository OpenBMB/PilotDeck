import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatReviewProvider, useChatReview } from './ChatReviewContext';
import ChangesReviewTab from './ChangesReviewTab';
import type { Project, ProjectSession } from '../../types/app';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('./CheckpointDiffViewer', () => ({ default: ({ diff }: { diff: { newContent: string } }) => <pre data-testid="loaded-diff">{diff.newContent}</pre> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Controls() {
  const review = useChatReview()!;
  return <><button onClick={() => review.setScope('session')}>Session</button><button onClick={() => review.setScope('turn')}>Turn</button><button onClick={() => void review.refresh()}>Refresh</button></>;
}

it('reloads session diff on restore and undo even with identical checkpoint, path and line counts; keeps historical diffs stable', async () => {
  const change = { path: 'demo.txt', operation: 'updated', source: 'file_tool', added: 1, removed: 1, restorable: true, binary: false };
  const checkpoint = { id: 'checkpoint', phase: 'after', turnId: 'turn', changes: [change], activeBranch: false, createdAt: '2026-10-09T00:00:00Z' };
  let revision = 'original', content = 'C';
  mocks.fetch.mockImplementation(async (_url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    const body = input.action === 'list' ? { checkpoints: [checkpoint], sessionChanges: [change], sessionRevision: revision, operations: [], busy: false }
      : input.action === 'diff' ? { path: change.path, newContent: input.scope === 'session' ? content : 'historical', hunks: [] } : {};
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  });
  render(<ChatReviewProvider project={{ name: 'qa', fullPath: '/qa' } as Project} session={{ id: 's' } as ProjectSession} onOpen={() => {}}><Controls /><ChangesReviewTab wide={false} /></ChatReviewProvider>);
  await screen.findByText('historical');
  fireEvent.click(screen.getByText('Session')); await screen.findByText('C');
  const requests = () => mocks.fetch.mock.calls.filter(([, options]) => options?.body && JSON.parse(options.body).action === 'diff');
  revision = 'restored'; content = 'B'; fireEvent.click(screen.getByText('Refresh')); await screen.findByText('B');
  expect(requests()).toHaveLength(3);
  revision = 'undone'; content = 'C'; fireEvent.click(screen.getByText('Refresh')); await screen.findByText('C');
  expect(requests()).toHaveLength(4);
  fireEvent.click(screen.getByText('Turn')); await screen.findByText('historical');
  revision = 'later-restore'; content = 'B'; fireEvent.click(screen.getByText('Refresh'));
  await waitFor(() => expect(mocks.fetch.mock.calls.filter(([, options]) => options?.body && JSON.parse(options.body).action === 'list')).toHaveLength(4));
  expect(requests()).toHaveLength(5); expect(screen.getByTestId('loaded-diff').textContent).toBe('historical');
});
