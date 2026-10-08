import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '../../i18n/locales/zh-CN/common.json';
import { WorkspaceUploadStatus } from './WorkspaceUploadStatus';
import type { WorkspaceUpload } from './useWorkspaceUpload';

const i18n = createInstance();
beforeAll(async () => { await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: common } } }); });
afterEach(cleanup);

function showConflict(savedNames: string[], files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]) {
  const upload: WorkspaceUpload = {
    stage: 'failed', files, targetPath: '', percent: 100, uploadedBytes: 2, totalBytes: 2,
    savedNames, retryFiles: [], errorCode: 'UPLOAD_FILE_EXISTS',
    failures: files.filter(file => !savedNames.includes(file.name)).map(file => ({ name: file.name, message: i18n.t('fileTree.uploadStatus.fileExists') })),
    error: i18n.t('fileTree.uploadStatus.partial', { saved: savedNames.length, failed: files.length - savedNames.length }),
  };
  const dismiss = vi.fn();
  render(<I18nextProvider i18n={i18n}><WorkspaceUploadStatus upload={upload} onCancel={vi.fn()} onRetry={vi.fn()} onDismiss={dismiss} /></I18nextProvider>);
  return dismiss;
}

describe('name conflict results', () => {
  it('retains the saved/failed counts and each file result for a partially saved batch', () => {
    showConflict(['a.txt']);
    expect(screen.getByRole('status').textContent).toBe('1 个文件上传失败');
    expect(screen.getByRole('alert').textContent).toContain('1 个已保存，1 个失败');
    fireEvent.click(screen.getByText('查看详情'));
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('a.txt')).toBeTruthy();
    expect(within(rows[0]).getByText('已保存')).toBeTruthy();
    expect(within(rows[1]).getByText('b.txt')).toBeTruthy();
    expect(within(rows[1]).getByText('存在同名文件或文件夹')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it.each([1, 2])('keeps the compact two-line message when no file was saved (%i selected)', count => {
    const dismiss = showConflict([], [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')].slice(0, count));
    expect(screen.getByRole('alert').textContent).toBe('上传失败');
    expect(screen.getByText('存在同名文件或文件夹')).toBeTruthy();
    expect(screen.queryByText('查看详情')).toBeNull();
    expect(screen.queryByText('a.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
