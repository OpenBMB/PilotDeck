// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { ConfirmProvider } from '../../ui/ConfirmDialog';
import { MessageFileCard } from './MessageFileCards';

const mocks = vi.hoisted(() => ({ sha: vi.fn() }));
vi.mock('../../../utils/api', () => ({ api: { fileContentSha256: mocks.sha } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
