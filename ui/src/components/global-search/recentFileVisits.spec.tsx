// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { GlobalSearchProvider, useGlobalSearch } from './GlobalSearchContext';
import { readRecentFiles } from './recentFiles';
import { useEditorSidebar } from '../code-editor/hooks/useEditorSidebar';

const { fileMetadata } = vi.hoisted(() => ({ fileMetadata: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: { fileMetadata } }));
const project = { name: 'project', displayName: 'Example', fullPath: '/workspace' };
const wrapper = ({ children }: { children: ReactNode }) => <GlobalSearchProvider>{children}</GlobalSearchProvider>;
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); fileMetadata.mockReset(); });

describe('file activation history', () => {
  it('records file opens, preview navigation and tab switches, deduplicating absolute aliases', async () => {
    fileMetadata.mockResolvedValue({ ok: true, status: 200 });
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const { result } = renderHook(() => ({
      editor: useEditorSidebar({ selectedProject: project, isMobile: false }), search: useGlobalSearch(),
    }), { wrapper });
    act(() => result.current.editor.handleFileOpen('README.md'));
    await waitFor(() => expect(result.current.search?.recentFiles).toHaveLength(1));
    const firstTab = result.current.editor.activeEditorTabId!;
    act(() => result.current.editor.handlePreviewFileOpen('docs/guide.md'));
    await waitFor(() => expect(result.current.search?.recentFiles[0].path).toBe('docs/guide.md'));
    act(() => result.current.editor.handleFileOpen('two.pdf'));
    await waitFor(() => expect(result.current.search?.recentFiles[0].path).toBe('two.pdf'));
    act(() => result.current.editor.handleTabSelect(firstTab));
    await waitFor(() => expect(result.current.search?.recentFiles[0].path).toBe('docs/guide.md'));
    act(() => result.current.editor.handleFileOpen('/workspace/docs/guide.md'));
    expect(result.current.search?.recentFiles).toHaveLength(3);
    expect(fileMetadata).toHaveBeenCalledWith('project', 'two.pdf');
    expect(readRecentFiles('local')[0].path).toBe('docs/guide.md');
  });

  it('does not record inaccessible files and isolates accounts including late validation responses', async () => {
    let resolve: (response: unknown) => void = () => {};
    fileMetadata.mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue({ ok: false, status: 403 });
    let userKey = 'alice';
    const { result, rerender } = renderHook(() => useGlobalSearch(), {
      wrapper: ({ children }: { children: ReactNode }) => <GlobalSearchProvider userKey={userKey}>{children}</GlobalSearchProvider>,
    });
    act(() => result.current?.recordFileVisit(project, 'a.md'));
    userKey = 'bob'; rerender();
    await act(async () => resolve({ ok: true, status: 200 }));
    expect(result.current?.recentFiles).toEqual([]);
    expect(readRecentFiles('alice')).toHaveLength(1);
    await act(async () => result.current?.recordFileVisit(project, 'forbidden.md'));
    expect(result.current?.recentFiles).toEqual([]);
    userKey = 'alice'; rerender();
    expect(result.current?.recentFiles).toHaveLength(1);
  });
});
