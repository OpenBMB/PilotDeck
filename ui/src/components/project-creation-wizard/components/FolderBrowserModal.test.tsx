// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FolderBrowserModal from './FolderBrowserModal';

const mocks = vi.hoisted(() => ({
  language: 'zh-CN',
  browseFilesystemFolders: vi.fn(),
}));

vi.mock('lucide-react', () => ({
  Eye: () => null,
  EyeOff: () => null,
  FolderOpen: () => null,
  FolderPlus: () => null,
  Loader2: () => null,
  Plus: () => null,
  X: () => null,
}));

vi.mock('react-i18next', async () => {
  const enCommon = (await import('../../../i18n/locales/en/common.json')).default as Record<string, unknown>;
  const zhCommon = (await import('../../../i18n/locales/zh-CN/common.json')).default as Record<string, unknown>;
  const lookupTranslation = (resources: Record<string, unknown>, key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined),
      resources,
    );
    return typeof value === 'string' ? value : key;
  };
  const t = (key: string) => lookupTranslation(mocks.language === 'zh-CN' ? zhCommon : enCommon, key);

  return {
    useTranslation: () => ({
      t,
      i18n: { language: mocks.language, changeLanguage: vi.fn() },
    }),
  };
});

vi.mock('../data/workspaceApi', () => ({
  browseFilesystemFolders: mocks.browseFilesystemFolders,
  createFolderInFilesystem: vi.fn(),
}));

describe('FolderBrowserModal', () => {
  beforeEach(() => {
    mocks.language = 'zh-CN';
    mocks.browseFilesystemFolders.mockResolvedValue({
      path: 'C:\\Users\\wukai',
      suggestions: [{ name: 'Desktop', path: 'C:\\Users\\wukai\\Desktop' }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders Chinese copy when the interface language is zh-CN', async () => {
    render(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: '选择文件夹' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择' })).toBeTruthy();
    });
    expect(screen.getByText('路径：')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用此文件夹' })).toBeTruthy();
  });

  it('renders English copy when the interface language is en', async () => {
    mocks.language = 'en';
    render(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Select Folder' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy();
    });
    expect(screen.getByText('Path:')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeTruthy();
  });
});
