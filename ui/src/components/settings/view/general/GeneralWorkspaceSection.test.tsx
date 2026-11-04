import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import GeneralWorkspaceSection from './GeneralWorkspaceSection';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), success: vi.fn() }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../../shared/SettingsSuccessToast', () => ({ showSettingsSuccess: mocks.success }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../project-creation-wizard/components/FolderBrowserModal', () => ({ default: ({ onFolderSelected }: { onFolderSelected: (path: string) => void }) =>
  <button onClick={() => onFolderSelected('/selected/folder')}>select-folder</button> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const settings = { directory: '', defaultDirectory: '/home/user/PilotDeckGeneral', effectiveDirectory: '/home/user/PilotDeckGeneral' };
const reply = (data: unknown, ok = true) => ({ ok, json: async () => data });

it('loads, browses, saves and restores the server default', async () => {
  mocks.fetch.mockResolvedValueOnce(reply(settings));
  render(<GeneralWorkspaceSection />);
  const input = screen.getByRole('textbox', { name: 'generalWorkspace.directory' }) as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.placeholder).toBe('/home/user/PilotDeckGeneral');
  expect(screen.getByRole('button', { name: 'generalWorkspace.save' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'generalWorkspace.browse' }));
  fireEvent.click(screen.getByText('select-folder'));
  expect(input.value).toBe('/selected/folder');
  mocks.fetch.mockResolvedValueOnce(reply({ ...settings, directory: input.value, effectiveDirectory: input.value }));
  fireEvent.click(screen.getByRole('button', { name: 'generalWorkspace.save' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ directory: '/selected/folder' });
  mocks.fetch.mockResolvedValueOnce(reply(settings));
  fireEvent.click(screen.getByRole('button', { name: 'generalWorkspace.reset' }));
  await waitFor(() => expect(input.value).toBe(''));
  expect(JSON.parse(mocks.fetch.mock.calls[2][1].body)).toEqual({ directory: '' });
});

it('preserves a failed draft and translates the safety error', async () => {
  mocks.fetch.mockResolvedValueOnce(reply(settings));
  render(<GeneralWorkspaceSection />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: '/unsafe/profile' } });
  mocks.fetch.mockResolvedValueOnce(reply({ code: 'GENERAL_WORKSPACE_UNSAFE' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'generalWorkspace.save' }));
  expect((await screen.findByRole('alert')).textContent).toBe('generalWorkspace.unsafeError');
  expect(input.value).toBe('/unsafe/profile');
  expect(mocks.success).not.toHaveBeenCalled();
});

it('can retry an unavailable initial load without saving an unknown directory', async () => {
  mocks.fetch.mockRejectedValueOnce(new Error('offline'));
  render(<GeneralWorkspaceSection />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'generalWorkspace.save' }).hasAttribute('disabled')).toBe(true);
  mocks.fetch.mockResolvedValueOnce(reply(settings));
  fireEvent.click(screen.getByRole('button', { name: 'generalWorkspace.retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
