import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatReviewProvider, useChatReview, type GitEntry } from './ChatReviewContext';
import GitReviewTab from './GitReviewTab';
import type { Project, ProjectSession } from '../../types/app';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([
  ['Windows drive', 'c:\\repo\\Subproject', 'C:/Repo', 'subproject/Report.txt'],
  ['Windows UNC', '\\\\SERVER\\Share\\Repo\\Subproject', '//server/share/repo', 'subproject/Report.txt'],
  ['POSIX', '/repo/subproject', '/repo', 'subproject/report.txt'],
  ['repository root', 'c:\\REPO', 'C:/Repo', 'Report.txt'],
])('preselects the round files using Git filenames in a %s workspace', async (_label, workspace, repository, file) => {
  const checkpoint = { id: 'checkpoint', phase: 'after', turnId: 'turn', sessionId: 'session', createdAt: '2026-10-09T00:00:00Z', status: 'complete', changes: [{ path: 'report.txt' }] };
  const entry = (path: string) => ({ path, indexStatus: '?', worktreeStatus: '?', untracked: true, unstaged: true });
  mocks.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    const body = input.action === 'list' ? { checkpoints: [checkpoint], sessionChanges: checkpoint.changes, operations: [], busy: false }
      : url.includes('/git/status') ? { branch: 'main', repositoryRoot: repository, hasCommits: true, entries: [entry(file), entry('unrelated.txt')] }
      : url.includes('/git/branches') ? { localBranches: ['main'] } : {};
    return { ok: true, json: async () => body };
  });
  render(<ChatReviewProvider project={{ name: 'project', fullPath: workspace } as Project} session={{ id: 'session' } as ProjectSession} openGit onOpen={() => {}}>
    <GitReviewTab />
  </ChatReviewProvider>);
  const selected = await screen.findByLabelText(`选择未暂存文件 ${file}`) as HTMLInputElement;
  await waitFor(() => expect(selected.checked).toBe(true));
  expect((screen.getByLabelText('选择未暂存文件 unrelated.txt') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '暂存所选' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/git/operation')).toBe(true));
  const [, options] = mocks.fetch.mock.calls.find(([url]) => url === '/api/git/operation')!;
  expect(JSON.parse(options.body)).toMatchObject({ operation: 'stage', files: [file] });
});

it('keeps manual selections across fresh status/checkpoint responses, drops missing files, and stages the chosen files', async () => {
  const checkpoint = { id: 'checkpoint', phase: 'after', turnId: 'turn', changes: [{ path: 'round.txt' }] };
  let files = ['round.txt', 'manual.txt'];
  const entry = (path: string) => ({ path, indexStatus: '?', worktreeStatus: '?', untracked: true, unstaged: true });
  mocks.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    const body = input.action === 'list' ? { checkpoints: [checkpoint], sessionChanges: checkpoint.changes, operations: [], busy: false }
      : url.includes('/git/status') ? { branch: 'main', repositoryRoot: '/qa', hasCommits: true, entries: files.map(entry) }
      : url.includes('/git/branches') ? { localBranches: ['main'] } : {};
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  });
  function Controls() {
    const review = useChatReview()!;
    return <button onClick={() => { void review.refresh(); void review.refreshGit(); }}>Refresh test</button>;
  }
  render(<ChatReviewProvider project={{ name: 'qa', fullPath: '/qa' } as Project} session={{ id: 'session' } as ProjectSession} openGit onOpen={() => {}}><Controls /><GitReviewTab /></ChatReviewProvider>);
  const round = await screen.findByLabelText('选择未暂存文件 round.txt') as HTMLInputElement;
  await waitFor(() => expect(round.checked).toBe(true));
  fireEvent.click(round); fireEvent.click(screen.getByLabelText('选择未暂存文件 manual.txt'));
  fireEvent.click(screen.getByText('Refresh test'));
  await waitFor(() => expect(mocks.fetch.mock.calls.filter(([, options]) => options?.body && JSON.parse(options.body).action === 'list')).toHaveLength(2));
  expect(round.checked).toBe(false); expect((screen.getByLabelText('选择未暂存文件 manual.txt') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '暂存所选' }));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/git/operation')).toBe(true));
  expect(JSON.parse(mocks.fetch.mock.calls.find(([url]) => url === '/api/git/operation')![1].body)).toMatchObject({ files: ['manual.txt'] });
  files = ['round.txt']; fireEvent.click(screen.getByText('Refresh test'));
  await waitFor(() => expect(screen.queryByLabelText('选择未暂存文件 manual.txt')).toBeNull());
  expect(round.checked).toBe(false);
});

function gitEntry(path: string, options: Partial<GitEntry> = {}): GitEntry {
  return { path, indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false, conflicted: false, ...options };
}
function renderRepository(initialEntries: GitEntry[], busy = false) {
  let entries = initialEntries;
  mocks.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    const body = input.action === 'list' ? { checkpoints: [], sessionChanges: [], operations: [], busy }
      : url.includes('/git/status') ? { branch: 'main', repositoryRoot: '/qa', hasCommits: true, indexTree: 'reviewed-index', entries }
      : url.includes('/git/branches') ? { localBranches: ['main'] } : {};
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  });
  function Controls() {
    const review = useChatReview()!;
    return <button onClick={() => { void review.refresh(); void review.refreshGit(); }}>Refresh test</button>;
  }
  render(<ChatReviewProvider project={{ name: 'qa', fullPath: '/qa' } as Project} session={{ id: 'session' } as ProjectSession} openGit onOpen={() => {}}>
    <Controls /><GitReviewTab />
  </ChatReviewProvider>);
  return { setEntries: (next: GitEntry[]) => { entries = next; } };
}
const operations = () => mocks.fetch.mock.calls.filter(([url]) => url === '/api/git/operation').map(([, options]) => JSON.parse(options.body));

it('selects and clears each group independently, including a partially staged file', async () => {
  renderRepository([gitEntry('mixed.txt', { staged: true, indexStatus: 'M' }), gitEntry('other.txt')]);
  const unstaged = within(await screen.findByRole('group', { name: '未暂存' }));
  const staged = within(screen.getByRole('group', { name: '已暂存' }));
  fireEvent.click(unstaged.getByLabelText('选择未暂存文件 mixed.txt'));
  const all = unstaged.getByLabelText('全选未暂存文件') as HTMLInputElement;
  expect(all.indeterminate).toBe(true); expect(all.getAttribute('aria-checked')).toBe('mixed');
  expect((staged.getByLabelText('选择已暂存文件 mixed.txt') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(staged.getByLabelText('全选已暂存文件')); fireEvent.click(all);
  expect((unstaged.getByLabelText('取消全选未暂存文件') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(unstaged.getByRole('button', { name: '取消选择未暂存文件' }));
  expect((unstaged.getByLabelText('选择未暂存文件 mixed.txt') as HTMLInputElement).checked).toBe(false);
  expect((staged.getByLabelText('选择已暂存文件 mixed.txt') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(staged.getByLabelText('取消全选已暂存文件'));
  expect((staged.getByLabelText('选择已暂存文件 mixed.txt') as HTMLInputElement).checked).toBe(false);
  expect(operations()).toEqual([]);
});

it.each(['staged', 'unstaged'] as const)('offers the complete %s group when nothing is selected', async side => {
  const staged = side === 'staged', path = 'docs/new [1].txt';
  renderRepository([
    gitEntry(path, { staged, unstaged: !staged, ...(staged ? { originalPath: 'docs/old.txt', indexStatus: 'R' } : {}) }),
    gitEntry('报告.txt', { staged, unstaged: !staged }),
  ]);
  const group = within(await screen.findByRole('group', { name: staged ? '已暂存' : '未暂存' }));
  fireEvent.click(group.getByRole('button', { name: staged ? '取消暂存全部' : '暂存全部' }));
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: staged ? 'unstage' : 'stage', files: staged ? [path, 'docs/old.txt', '报告.txt'] : [path, '报告.txt'] });
});

it.each(['staged', 'unstaged'] as const)('limits the %s group operation to the selected files', async side => {
  const staged = side === 'staged';
  renderRepository([
    gitEntry('chosen.txt', { staged, unstaged: !staged }), gitEntry('other.txt', { staged, unstaged: !staged }),
    gitEntry('opposite.txt', { staged: !staged, unstaged: staged }),
  ]);
  const label = staged ? '已暂存' : '未暂存';
  const group = within(await screen.findByRole('group', { name: label }));
  fireEvent.click(group.getByLabelText(`选择${label}文件 chosen.txt`));
  fireEvent.click(screen.getByLabelText(`选择${staged ? '未暂存' : '已暂存'}文件 opposite.txt`));
  fireEvent.click(group.getByRole('button', { name: staged ? '取消暂存所选' : '暂存所选' }));
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: staged ? 'unstage' : 'stage', files: ['chosen.txt'] });
});

it.each(['staged', 'unstaged'] as const)('supports direct %s file operations independently of the selection', async side => {
  const staged = side === 'staged';
  renderRepository([
    gitEntry('chosen.txt', { staged, unstaged: !staged }),
    gitEntry('renamed.txt', { staged, unstaged: !staged, ...(staged ? { originalPath: 'original.txt', indexStatus: 'R' } : {}) }),
  ]);
  const label = staged ? '已暂存' : '未暂存';
  const group = within(await screen.findByRole('group', { name: label }));
  fireEvent.click(group.getByLabelText(`选择${label}文件 chosen.txt`));
  fireEvent.click(group.getByRole('button', { name: `${staged ? '取消暂存' : '暂存'} renamed.txt` }));
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: staged ? 'unstage' : 'stage', files: staged ? ['renamed.txt', 'original.txt'] : ['renamed.txt'] });
});

it('drops only the selection for a removed Git side during refresh', async () => {
  const mixed = gitEntry('mixed.txt', { staged: true, indexStatus: 'M' });
  const fixture = renderRepository([mixed, gitEntry('selected.txt', { staged: true, unstaged: false })]);
  await screen.findByRole('group', { name: '未暂存' });
  fireEvent.click(screen.getByLabelText('选择未暂存文件 mixed.txt'));
  fireEvent.click(screen.getByLabelText('选择已暂存文件 selected.txt'));
  fixture.setEntries([{ ...mixed, unstaged: false }, gitEntry('selected.txt', { staged: true, unstaged: false })]);
  fireEvent.click(screen.getByText('Refresh test'));
  await waitFor(() => expect(screen.queryByRole('group', { name: '未暂存' })).toBeNull());
  expect((screen.getByLabelText('选择已暂存文件 mixed.txt') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('选择已暂存文件 selected.txt') as HTMLInputElement).checked).toBe(true);
});

it('disables both batch and individual mutations while the workspace is busy', async () => {
  renderRepository([gitEntry('file.txt')], true);
  const group = within(await screen.findByRole('group', { name: '未暂存' }));
  await waitFor(() => expect((group.getByRole('button', { name: '暂存全部' }) as HTMLButtonElement).disabled).toBe(true));
  expect((group.getByRole('button', { name: '暂存 file.txt' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(group.getByRole('button', { name: '暂存全部' }));
  expect(operations()).toEqual([]);
});

it('lists conflicts once and allows staging their selected resolution', async () => {
  renderRepository([gitEntry('conflict.txt', { conflicted: true, staged: true, indexStatus: 'U', worktreeStatus: 'U' })]);
  const group = within(await screen.findByRole('group', { name: '待解决冲突' }));
  expect(screen.queryByRole('group', { name: '已暂存' })).toBeNull();
  expect(screen.queryByRole('group', { name: '未暂存' })).toBeNull();
  fireEvent.click(group.getByLabelText('全选待解决冲突文件'));
  fireEvent.click(group.getByRole('button', { name: '暂存所选' }));
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: 'stage', files: ['conflict.txt'] });
});

it('commits the reviewed index with the message, independently of file selection', async () => {
  renderRepository([gitEntry('first.txt', { staged: true, unstaged: false }), gitEntry('second.txt', { staged: true, unstaged: false })]);
  await screen.findByRole('group', { name: '已暂存' });
  const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('选择已暂存文件 first.txt'));
  fireEvent.change(screen.getByLabelText('Git 提交说明'), { target: { value: '  Update files  ' } });
  expect(submit.disabled).toBe(false);
  expect(submit.title).toBe('提交暂存区的全部 2 个文件');
  fireEvent.click(submit);
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: 'commit', message: 'Update files', expectedIndexTree: 'reviewed-index' });
  expect(operations()[0].files).toBeUndefined();
  await waitFor(() => expect((screen.getByLabelText('Git 提交说明') as HTMLTextAreaElement).value).toBe(''));
});

it('reveals remote setup on demand and associates the supplied existing repository', async () => {
  renderRepository([]);
  await screen.findByText('工作区干净');
  expect(screen.queryByLabelText('远程仓库地址')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '连接远程仓库' }));
  const associate = screen.getByRole('button', { name: '关联仓库' }) as HTMLButtonElement;
  expect(associate.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('远程仓库地址'), { target: { value: 'https://github.com/example/existing.git' } });
  fireEvent.click(associate);
  await waitFor(() => expect(operations()).toHaveLength(1));
  expect(operations()[0]).toMatchObject({ operation: 'remote', remoteUrl: 'https://github.com/example/existing.git' });
  await waitFor(() => expect(screen.queryByLabelText('远程仓库地址')).toBeNull());
});
