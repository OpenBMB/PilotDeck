import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../types/app';
import { useEditorSidebar } from './useEditorSidebar';

const project = { name: 'project-a', path: '/workspace/project-a' } as Project;

describe('useEditorSidebar file tabs', () => {
  it('opens files in unique tabs and activates an existing tab without duplicating it', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('docs/one.md'));
    act(() => result.current.handleFileOpen('docs/two.pdf'));

    expect(result.current.editorTabs.map((tab) => tab.fileStack[0].path)).toEqual([
      'docs/one.md',
      'docs/two.pdf',
    ]);
    expect(result.current.activeFilePath).toBe('docs/two.pdf');

    act(() => result.current.handleFileOpen('docs/one.md'));

    expect(result.current.editorTabs).toHaveLength(2);
    expect(result.current.activeFilePath).toBe('docs/one.md');
  });

  it('keeps markdown preview navigation inside its tab and supports going back', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('README.md'));
    act(() => result.current.handlePreviewFileOpen('docs/guide.md'));

    expect(result.current.activeFilePath).toBe('docs/guide.md');
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.parentFile?.path).toBe('README.md');

    act(() => result.current.handleFileGoBack());

    expect(result.current.activeFilePath).toBe('README.md');
    expect(result.current.canGoBack).toBe(false);
  });

  it('selects the neighboring tab when the active tab closes', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('one.txt'));
    act(() => result.current.handleFileOpen('two.txt'));
    act(() => result.current.handleFileOpen('three.txt'));
    const middleTabId = result.current.editorTabs[1].id;
    act(() => result.current.handleTabSelect(middleTabId));
    act(() => result.current.handleTabClose(middleTabId));

    expect(result.current.activeFilePath).toBe('three.txt');
  });

  it('updates open paths after rename and closes tabs deleted with a directory', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('docs/one.md'));
    act(() => result.current.handleFileOpen('keep.md'));
    const renamedTabId = result.current.editorTabs[0].id;
    act(() => result.current.handleTabDirtyChange(renamedTabId, true));
    act(() => result.current.handleFileRename('docs', 'notes'));

    expect(result.current.editorTabs[0].fileStack[0].path).toBe('notes/one.md');
    expect(result.current.editorTabs[0].fileStack[0].renamedFromPath).toBe('docs/one.md');

    act(() => result.current.handleFileDelete('notes'));

    expect(result.current.editorTabs.map((tab) => tab.fileStack[0].path)).toEqual(['keep.md']);
    expect(result.current.activeFilePath).toBe('keep.md');
  });
});
