import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatReviewProvider, type ReviewOpenRequest } from './ChatReviewContext';
import TurnChangesCard from './TurnChangesCard';
import ChatReviewSidePanel from './ChatReviewSidePanel';
import type { Project, ProjectSession } from '../../types/app';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const changes = ['ready.txt', 'conflict.txt'].map(path => ({ path, operation: 'updated', source: 'file_tool', added: 1, removed: 1, restorable: true, binary: false }));
const checkpoint = { id: 'checkpoint', phase: 'after', turnId: 'turn', sessionId: 'session', createdAt: '2026-10-09T00:00:00Z', status: 'complete', activeBranch: true, unprotected: 0, changes };
const absent = { kind: 'absent' };
const plan = { id: 'plan', checkpointId: checkpoint.id, mode: 'files', scope: 'turn', files: [
  { path: 'ready.txt', status: 'ready', expected: absent, target: absent, source: 'file_tool' },
  { path: 'conflict.txt', status: 'conflict', expected: absent, target: absent, source: 'file_tool' },
] };
function setup(reviewChanges = changes, restorePlan = plan, operations: unknown[] = [], width = 500, openRequest?: ReviewOpenRequest, historyCheckpoints = [checkpoint]) {
  const reviewCheckpoints = historyCheckpoints.map(record => ({ ...record, changes: reviewChanges }));
  mocks.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    const body = input.action === 'list' ? { checkpoints: reviewCheckpoints, sessionChanges: reviewChanges, operations, busy: false }
      : input.action === 'preview' || input.action === 'undo' ? restorePlan : input.action === 'diff' ? { path: input.filePath, source: 'file_tool', hunks: [] }
      : input.action === 'restore' ? { id: restorePlan.id, status: 'complete' }
      : url.includes('/git/status') ? { branch: 'main', repositoryRoot: '/workspace', hasCommits: true, entries: [] }
      : {};
    return { ok: true, json: async () => body };
  });
  const content = (request?: ReviewOpenRequest) => <ChatReviewProvider project={{ name: 'workspace', fullPath: '/workspace' } as Project} session={{ id: 'session' } as ProjectSession} openRequest={request} onOpen={() => {}}>
    <textarea aria-label="聊天草稿" /><TurnChangesCard turnId="turn" />
    <ChatReviewSidePanel width={width} minWidth={300} maxWidth={800} isMobile={false} onResizeStart={() => {}} onResizeBy={() => {}} />
  </ChatReviewProvider>;
  const view = render(content(openRequest));
  return { openFromMenu: (request: ReviewOpenRequest) => view.rerender(content(request)) };
}

it('opens review from the turn and closing the panel preserves the conversation draft', async () => {
  setup(); await screen.findByTestId('turn-changes-card');
  const draft = screen.getByLabelText('聊天草稿'); fireEvent.change(draft, { target: { value: '继续完成未发出的需求' } });
  fireEvent.click(within(screen.getByTestId('turn-changes-card')).getByText('查看变更'));
  expect(await screen.findByTestId('chat-review-panel')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('收起改动面板'));
  expect(screen.queryByTestId('chat-review-panel')).toBeNull();
  expect((draft as HTMLTextAreaElement).value).toBe('继续完成未发出的需求');
  expect(screen.getByTestId('turn-changes-card')).toBeTruthy();
});

it('interleaves all history events by time across dates and keeps each action bound to its own event', async () => {
  const operation = { checkpointId: 'checkpoint', mode: 'files', status: 'complete', applied: ['report.pptx', '.pilotdeck/work/patch.py'], skipped: [] };
  setup(mixedChanges, mixedPlan, [
    { ...operation, id: 'restore', createdAt: '2026-10-09T05:08:15Z' },
    { ...operation, id: 'previous-day', mode: 'conversation', createdAt: '2026-10-08T05:00:00Z' },
    { ...operation, id: 'undo', undoOf: 'restore', createdAt: '2026-10-09T05:55:13Z' },
  ], 500, { tab: 'checkpoints', sequence: 1 }, [
    { ...checkpoint, id: 'latest-turn', createdAt: '2026-10-09T05:07:33Z' },
    { ...checkpoint, id: 'backup', phase: 'before_restore', createdAt: '2026-10-09T05:55:12Z' },
    { ...checkpoint, id: 'older-turn', activeBranch: false, createdAt: '2026-10-09T05:04:37Z' },
  ]);
  await screen.findByText('撤销恢复');
  const timeline = screen.getByRole('list', { name: '版本时间轴' });
  const events = within(timeline).getAllByRole('listitem');
  expect(events.map(event => event.getAttribute('data-history-id'))).toEqual(['undo', 'restore', 'latest-turn', 'older-turn', 'previous-day']);
  expect(within(timeline).getAllByRole('heading')).toHaveLength(2);
  expect(within(events[0]).getByText('撤销恢复')).toBeTruthy();
  expect(within(events[1]).getByText('恢复文件')).toBeTruthy();
  expect(within(events[4]).getByText('回退对话')).toBeTruthy();
  expect(timeline.textContent).not.toContain('.pilotdeck');
  fireEvent.click(within(events[3]).getByText('回到此轮开始前'));
  await screen.findByRole('dialog');
  const [, preview] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'preview')!;
  expect(JSON.parse(preview.body)).toMatchObject({ checkpointId: 'older-turn', scope: 'turn' });
  fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('confirmDialog.close'));
  fireEvent.click(within(events[0]).getByText('撤销此次操作'));
  await screen.findByRole('dialog');
  const [, undo] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'undo')!;
  expect(JSON.parse(undo.body).operationId).toBe('undo');
});

const mixedChanges = [
  { ...changes[0], path: '.pilotdeck/work/patch.py', added: 106, removed: 0 },
  { ...changes[0], path: 'report.pptx', added: 0, removed: 0, binary: true },
  { ...changes[0], path: '.pilotdeck/work/later.py', added: 25, removed: 3 },
];
const mixedPlan = { ...plan, files: mixedChanges.map(file => ({ ...plan.files[0], path: file.path, status: file.path.endsWith('later.py') ? 'conflict' : 'ready' })) };

it('projects user-only counts, statistics and navigation in both turn and session views', async () => {
  setup(mixedChanges, mixedPlan, [], 750);
  const card = await screen.findByTestId('turn-changes-card');
  expect(within(card).getByText('已更改 1 个文件')).toBeTruthy();
  expect(card.textContent).not.toContain('.pilotdeck');
  expect(card.textContent).not.toContain('+106');
  fireEvent.click(within(card).getByText('查看变更'));
  const panel = await screen.findByTestId('chat-review-panel');
  expect(within(panel).getByText('1 个文件')).toBeTruthy();
  expect(within(screen.getByLabelText('查看变更文件')).getAllByRole('option').map(option => option.textContent)).toEqual(['report.pptx']);
  fireEvent.change(screen.getByLabelText('审阅范围'), { target: { value: 'session' } });
  expect(panel.textContent).not.toContain('.pilotdeck');
  expect(panel.textContent).not.toContain('+106');
  const diffRequests = mocks.fetch.mock.calls.filter(([, options]) => options?.body && JSON.parse(options.body).action === 'diff');
  expect(diffRequests.length).toBeGreaterThan(0);
  expect(diffRequests.every(([, options]) => JSON.parse(options.body).filePath === 'report.pptx')).toBe(true);
  fireEvent.click(screen.getByLabelText('检查点历史'));
  expect(within(panel).getByText('1 个文件 · 完成')).toBeTruthy();
});

it('defaults to restoring recorded internal work files without exposing their paths or selecting conflicts', async () => {
  setup(mixedChanges, mixedPlan);
  const card = await screen.findByTestId('turn-changes-card');
  fireEvent.click(within(card).getByText('撤销'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).not.toContain('.pilotdeck');
  expect((within(dialog).getByLabelText('同时回退本轮内部工作文件') as HTMLInputElement).checked).toBe(true);
  expect(within(dialog).getByText('部分内部工作文件存在后续修改或缺少备份，将保留。')).toBeTruthy();
  fireEvent.click(within(dialog).getByText('确认恢复 1 个文件'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')).toBe(true));
  const [, request] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')!;
  expect(JSON.parse(request.body).paths).toEqual(['.pilotdeck/work/patch.py', 'report.pptx']);
});

it('can restore only the selected user file by excluding the internal work group', async () => {
  setup(mixedChanges, mixedPlan);
  fireEvent.click(within(await screen.findByTestId('turn-changes-card')).getByText('撤销'));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByLabelText('同时回退本轮内部工作文件'));
  fireEvent.click(within(dialog).getByText('确认恢复 1 个文件'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')).toBe(true));
  const [, request] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')!;
  expect(JSON.parse(request.body).paths).toEqual(['report.pptx']);
});

it('keeps internal-only turns restorable from history without an empty result card or diff request', async () => {
  setup([mixedChanges[0]], { ...mixedPlan, files: [mixedPlan.files[0]] }, [], 500, { tab: 'checkpoints', sequence: 1 });
  await screen.findByTestId('chat-review-panel');
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'list')).toBe(true));
  expect(screen.queryByTestId('turn-changes-card')).toBeNull();
  fireEvent.click(await screen.findByText('查看改动'));
  expect(await screen.findByText('当前范围没有用户文件变更。')).toBeTruthy();
  expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'diff')).toBe(false);
  fireEvent.click(screen.getByText('撤销本轮改动'));
  const dialog = await screen.findByRole('dialog');
  expect((within(dialog).getByLabelText('同时回退本轮内部工作文件') as HTMLInputElement).checked).toBe(true);
  expect((within(dialog).getByText('确认回退内部工作文件') as HTMLButtonElement).disabled).toBe(false);
});

it('opens auxiliary review from menu requests and keeps it closed until another request arrives', async () => {
  const { openFromMenu } = setup();
  await screen.findByTestId('turn-changes-card');
  expect(screen.queryByTestId('chat-review-panel')).toBeNull();
  const request: ReviewOpenRequest = { tab: 'checkpoints', sequence: 1 };
  openFromMenu(request);
  expect(await screen.findByRole('heading', { name: '检查点历史' })).toBeTruthy();
  fireEvent.click(screen.getByLabelText('收起改动面板'));
  openFromMenu(request);
  expect(screen.queryByTestId('chat-review-panel')).toBeNull();
  openFromMenu({ tab: 'checkpoints', sequence: 2 });
  expect(await screen.findByTestId('chat-review-panel')).toBeTruthy();
});

it('preserves internal files in undo-restoration plans while displaying only user counts', async () => {
  const undoPlan = { ...mixedPlan, undoOf: 'restoration' };
  setup(mixedChanges, undoPlan, [{ id: 'restoration', checkpointId: 'checkpoint', status: 'complete', mode: 'files', applied: mixedChanges.map(file => file.path), skipped: [] }]);
  const card = await screen.findByTestId('turn-changes-card');
  expect(within(card).getByText('已撤销本轮改动 · 当前展示本轮历史变更')).toBeTruthy();
  fireEvent.click(within(card).getByText('撤销此次恢复'));
  const dialog = await screen.findByRole('dialog');
  expect((within(dialog).getByLabelText('同时恢复本轮内部工作文件') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByText('确认恢复 1 个文件'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')).toBe(true));
  const [, request] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')!;
  expect(JSON.parse(request.body).paths).toEqual(['.pilotdeck/work/patch.py', 'report.pptx']);
});

it('restores only selected safe files and keeps conflict files unchecked', async () => {
  setup(); await screen.findByTestId('turn-changes-card');
  fireEvent.click(within(screen.getByTestId('turn-changes-card')).getByText('撤销'));
  const dialog = await screen.findByRole('dialog');
  const checkboxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[];
  expect(checkboxes[0].checked).toBe(true); expect(checkboxes[1].checked).toBe(false); expect(checkboxes[1].disabled).toBe(true);
  fireEvent.click(within(dialog).getByText('确认恢复 1 个文件'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')).toBe(true));
  const [, request] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'restore')!;
  expect(JSON.parse(request.body).paths).toEqual(['ready.txt']);
});

it('clears the previous file diff immediately while the next file is loading', async () => {
  setup();
  const originalFetch = mocks.fetch.getMockImplementation()!;
  let finishNext!: (value: unknown) => void;
  const nextDiff = new Promise(resolve => { finishNext = resolve; });
  const result = (path: string, text: string) => ({ path, source: 'file_tool', oldContent: '', newContent: text,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ type: 'add', text }] }],
  });
  mocks.fetch.mockImplementation(async (url, options) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    if (input.action !== 'diff') return originalFetch(url, options);
    return { ok: true, json: () => input.filePath === 'conflict.txt' ? nextDiff : Promise.resolve(result('ready.txt', 'first-version')) };
  });
  await screen.findByTestId('turn-changes-card');
  fireEvent.click(within(screen.getByTestId('turn-changes-card')).getByText('查看变更'));
  await screen.findByText('first-version');
  fireEvent.change(screen.getByLabelText('查看变更文件'), { target: { value: 'conflict.txt' } });
  expect(screen.queryByText('first-version')).toBeNull();
  await act(async () => { finishNext(result('conflict.txt', 'second-version')); });
  expect(await screen.findByText('second-version')).toBeTruthy();
});
