// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { ConfirmProvider } from '../../ui/ConfirmDialog';
import { MessageFileCard } from './MessageFileCards';
import { useWorkspaceFileActions } from '../hooks/useWorkspaceFileActions';
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from '../../../utils/workspaceFileMention';

const mocks = vi.hoisted(() => ({ sha: vi.fn(), download: vi.fn() }));
vi.mock('../../../utils/api', () => ({ api: { fileContentSha256: mocks.sha, fileDownloadUrl: mocks.download } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('checks and downloads task files in their worktree while references retain the conversation project', async () => {
  const i18n = await createTestI18n('en'), onBrowse = vi.fn(), reference = vi.fn();
  const project = { name: 'source', displayName: 'Source', fullPath: '/source', workspaceCwd: '/task-worktree', fileOperationsKey: 'cron-task:task-a' };
  mocks.sha.mockResolvedValue({ ok: true, headers: new Headers({ 'X-PilotDeck-Content-SHA256': 'same-content' }) });
  mocks.download.mockReturnValue('http://localhost/task-download');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { result } = renderHook(() => useWorkspaceFileActions({ name: 'report.md', path: '/task-worktree/report.md', sha256: 'same-content' }, project, onBrowse),
    { wrapper: ({ children }) => <I18nextProvider i18n={i18n}><ConfirmProvider>{children}</ConfirmProvider></I18nextProvider> });
  await act(async () => result.current.browse());
  expect(mocks.sha).toHaveBeenCalledWith('cron-task:task-a', 'report.md');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onBrowse).toHaveBeenCalledWith('report.md');
  act(() => result.current.download());
  expect(mocks.download).toHaveBeenCalledWith('cron-task:task-a', 'report.md'); expect(click).toHaveBeenCalledTimes(1);
  window.addEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, reference);
  try { act(() => result.current.reference());
    expect(reference.mock.calls[0][0].detail).toEqual({ projectName: 'source', relativePath: 'report.md' });
  } finally { window.removeEventListener(ADD_WORKSPACE_FILE_MENTION_EVENT, reference); }
});

describe('changed file preview confirmation', () => {
  it.each(['en', 'zh-CN'])('waits for explicit confirmation in %s and does not open on cancel', async (language) => {
    const i18n = await createTestI18n(language);
    const onBrowse = vi.fn();
    mocks.sha.mockResolvedValue({ ok: true, headers: new Headers({ 'X-PilotDeck-Content-SHA256': 'new-content' }) });
    render(<I18nextProvider i18n={i18n}><ConfirmProvider>
      <MessageFileCard file={{ id: 'report', name: 'report.md', path: 'report.md', sha256: 'old-content' }} source="agent" project={{ name: 'demo', displayName: 'Demo', path: '/demo', fullPath: '/demo' }} onBrowse={onBrowse} />
    </ConfirmProvider></I18nextProvider>);
    fireEvent.click(screen.getByTitle(i18n.t('chat:fileArtifacts.browseTitle')));
    await screen.findByRole('dialog');
    expect(onBrowse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('confirmDialog.cancel') }));
    await act(async () => {});
    expect(onBrowse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle(i18n.t('chat:fileArtifacts.browseTitle')));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('confirmDialog.open') }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledWith('report.md'));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });
});
