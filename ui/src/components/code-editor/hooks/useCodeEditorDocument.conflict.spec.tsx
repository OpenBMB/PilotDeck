import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCodeEditorDocument } from './useCodeEditorDocument';
import { api } from '../../../utils/api';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../utils/api', () => ({ api: { readFile: vi.fn(), saveFile: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('sends the loaded version and keeps the draft when another writer causes a save conflict', async () => {
  vi.mocked(api.readFile).mockResolvedValue({ ok: true, json: async () => ({ content: 'original', hash: 'original-hash' }) } as Response);
  vi.mocked(api.saveFile).mockResolvedValue({ ok: false, status: 409, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: '文件已被修改，请重新读取后再保存。' }) } as Response);
  const { result } = renderHook(() => useCodeEditorDocument({ file: { name: 'test.txt', path: 'test.txt', projectName: 'project' } }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setContent('my unsaved draft'));
  await act(() => result.current.handleSave());
  expect(api.saveFile).toHaveBeenCalledWith('project', 'test.txt', 'my unsaved draft', 'original-hash');
  expect(result.current.content).toBe('my unsaved draft');
  expect(result.current.isDirty).toBe(true);
  expect(result.current.saveError).toContain('文件已被修改');
});
