import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../types/app';
import type { ChatFileArtifact } from '../chat/types/types';
import { ChatReviewProvider, type CheckpointSummary } from './ChatReviewContext';
import TurnFileResults from './TurnChangesCard';
import { mergeTurnFiles } from './turnFiles';
import { isInternalReviewPath } from './reviewFiles';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), sha: vi.fn(), download: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch, api: { fileContentSha256: mocks.sha, fileDownloadUrl: mocks.download } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue: string }) => options?.defaultValue || key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project = { name: 'workspace', fullPath: '/workspace', displayName: 'Workspace' } as Project;
const artifact = (path: string): ChatFileArtifact => ({ id: path, name: path.split('/').at(-1)!, path, operation: 'created', source: 'tool', status: 'complete', size: 120, sha256: 'hash', createdAt: '2026-10-09T00:00:00Z' });
const checkpoint = {
  id: 'checkpoint', phase: 'after', turnId: 'turn', sessionId: 'session', workspace: '/workspace', version: 1, createdAt: '2026-10-09T00:00:00Z', status: 'complete', unprotected: 0,
  changes: ['report.pdf', 'config.json', 'note.md', 'obsolete.txt'].map(path => ({ path, operation: path === 'obsolete.txt' ? 'deleted' : 'updated', source: 'file_tool', added: 1, removed: 1, restorable: true, binary: path.endsWith('.pdf') })),
} as CheckpointSummary;
function setup(restored = false) {
  mocks.sha.mockResolvedValue({ ok: true, headers: new Headers({ 'X-PilotDeck-Content-SHA256': 'hash' }) });
  mocks.fetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    const input = options?.body ? JSON.parse(options.body) : {};
    return { ok: true, json: async () => input.action === 'list' ? {
      checkpoints: [checkpoint], sessionChanges: checkpoint.changes, busy: false,
      operations: restored ? [{ id: 'restoration', checkpointId: 'checkpoint', mode: 'files', status: 'complete', applied: ['report.pdf'], skipped: ['config.json'] }] : [],
    } : {} };
  });
  const onBrowse = vi.fn();
  const view = render(<ChatReviewProvider project={project} session={{ id: 'session' } as ProjectSession} onOpen={() => {}}><TurnFileResults turnId="turn" artifacts={[artifact('/workspace/report.pdf'), artifact('./config.json'), artifact('note.md')]} onBrowse={onBrowse} /></ChatReviewProvider>);
  return { ...view, onBrowse };
}

it('merges absolute and relative artifact paths with checkpoint changes, including deletions', () => {
  const files = mergeTurnFiles([artifact('/workspace/config.json'), artifact('./config.json')], checkpoint, project);
  expect(files).toHaveLength(4);
  expect(files.filter(file => file.path === 'config.json')).toHaveLength(1);
  expect(files.find(file => file.path === 'obsolete.txt')?.change?.operation).toBe('deleted');
  const windows = { ...project, fullPath: 'C:\\Workspace' };
  expect(mergeTurnFiles([artifact('c:/workspace/CONFIG.json')], { ...checkpoint, changes: [checkpoint.changes[1]] }, windows)).toHaveLength(1);
});

it('renders one expandable card and keeps preview and reference actions on the same file row', async () => {
  const { container, onBrowse } = setup();
  await screen.findByText('已更改 4 个文件');
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  expect(container.querySelectorAll('[data-turn-file="config.json"]')).toHaveLength(1);
  expect(screen.queryByText('obsolete.txt')).toBeNull();
  fireEvent.click(screen.getByText('展开其余 1 个文件'));
  const deleted = container.querySelector('[data-turn-file="obsolete.txt"]')! as HTMLElement;
  expect(within(deleted).queryByText('下载当前文件')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'report.pdf' }));
  await waitFor(() => expect(onBrowse).toHaveBeenCalledWith('report.pdf'));
  const row = container.querySelector('[data-turn-file="report.pdf"]')! as HTMLElement;
  fireEvent.click(within(row).getByLabelText('report.pdf 的文件操作'));
  expect(screen.getByText('预览当前文件')).toBeTruthy();
  expect(screen.getByText('下载当前文件')).toBeTruthy();
  const reference = vi.fn(); window.addEventListener('pilotdeck:add-workspace-file-mention', reference);
  fireEvent.click(screen.getByText('在对话中引用'));
  expect(reference.mock.calls[0][0].detail).toEqual({ projectName: 'workspace', relativePath: 'report.pdf' });
  window.removeEventListener('pilotdeck:add-workspace-file-mention', reference);
});

it('offers undoing the restoration instead of repeating the completed restore', async () => {
  setup(true);
  const button = await screen.findByText('撤销此次恢复');
  expect(screen.queryByText('撤销')).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).action === 'undo')).toBe(true));
  const [, request] = mocks.fetch.mock.calls.find(([, options]) => options?.body && JSON.parse(options.body).action === 'undo')!;
  expect(JSON.parse(request.body).operationId).toBe('restoration');
});

it('keeps legacy artifacts actionable without inventing a restore or a change count', () => {
  const onBrowse = vi.fn();
  render(<TurnFileResults artifacts={[artifact('report.pdf')]} project={project} onBrowse={onBrowse} />);
  expect(screen.getByText('本轮文件 · 1')).toBeTruthy();
  expect(screen.queryByText('撤销')).toBeNull();
  expect(screen.queryByText('查看变更')).toBeNull();
});

it('hides internal files from both historical checkpoints and artifacts without hiding other dotfiles', () => {
  const paths = ['.pilotdeck/work/script.py', '/workspace/.pilotdeck/work/other.py', '.env', '.gitignore', '.github/workflows/test.yml', '.pilotdeck-example/readme.md'];
  const files = mergeTurnFiles(paths.map(artifact), { ...checkpoint, changes: paths.map(path => ({ ...checkpoint.changes[1], path })) }, project);
  expect(files.map(file => file.path)).toEqual(paths.slice(2));
  expect(isInternalReviewPath('c:\\workspace\\.PILOTDECK\\work\\script.py', 'C:\\Workspace')).toBe(true);
  expect(isInternalReviewPath('/home/.pilotdeck/projects/workspace/.env', '/home/.pilotdeck/projects/workspace')).toBe(false);
  render(<TurnFileResults artifacts={[artifact('.pilotdeck/work/script.py')]} project={project} />);
  expect(screen.queryByTestId('turn-changes-card')).toBeNull();
});
