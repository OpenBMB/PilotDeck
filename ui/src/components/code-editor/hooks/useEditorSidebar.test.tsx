import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../types/app';
import { useEditorSidebar } from './useEditorSidebar';

const project = { name: 'project-a', path: '/workspace/project-a' } as Project;
const windowsProject = { name: 'project-w', path: 'C:\\Work\\PilotDeck' } as Project;

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

  it('treats absolute and relative paths to the same workspace file as one tab', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('docs/report.xlsx'));
    act(() => result.current.handleFileOpen('/workspace/project-a/docs/report.xlsx'));

    expect(result.current.editorTabs).toHaveLength(1);
    expect(result.current.activeFilePath).toBe('docs/report.xlsx');
  });

  it('does not merge same-named files from different workspace folders', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('/workspace/project-a/one/report.xlsx'));
    act(() => result.current.handleFileOpen('two/report.xlsx'));

    expect(result.current.editorTabs.map((tab) => tab.fileStack[0].path)).toEqual([
      'one/report.xlsx',
      'two/report.xlsx',
    ]);
  });

  it('reuses a tab when its current preview file is opened from another surface', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('README.md'));
    act(() => result.current.handlePreviewFileOpen('docs/guide.md'));
    act(() => result.current.handleFileOpen('/workspace/project-a/docs/guide.md'));

    expect(result.current.editorTabs).toHaveLength(1);
    expect(result.current.editorTabs[0].fileStack.map((file) => file.path)).toEqual([
      'README.md',
      'docs/guide.md',
    ]);
    expect(result.current.activeFilePath).toBe('docs/guide.md');
  });

  it('activates an existing tab when preview navigation targets its current file', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('docs/guide.md'));
    const guideTabId = result.current.activeEditorTabId;
    act(() => result.current.handleFileOpen('README.md'));
    act(() => result.current.handlePreviewFileOpen('docs/guide.md'));

    expect(result.current.editorTabs).toHaveLength(2);
    expect(result.current.activeEditorTabId).toBe(guideTabId);
    expect(result.current.activeFilePath).toBe('docs/guide.md');
  });

  it('opens a root-history file in a new tab when the current file has unsaved changes', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('README.md'));
    act(() => result.current.handlePreviewFileOpen('docs/guide.md'));
    const dirtyTabId = result.current.activeEditorTabId!;
    act(() => result.current.handleTabDirtyChange(dirtyTabId, true));
    act(() => result.current.handleFileOpen('/workspace/project-a/README.md'));

    expect(result.current.editorTabs).toHaveLength(2);
    expect(result.current.editorTabs[0].dirty).toBe(true);
    expect(result.current.editorTabs[0].fileStack.map((file) => file.path)).toEqual([
      'README.md',
      'docs/guide.md',
    ]);
    expect(result.current.activeEditorTabId).not.toBe(dirtyTabId);
    expect(result.current.activeFilePath).toBe('README.md');
  });

  it('opens preview navigation in a new tab when the current file has unsaved changes', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('README.md'));
    act(() => result.current.handlePreviewFileOpen('docs/guide.md'));
    const dirtyTabId = result.current.activeEditorTabId!;
    act(() => result.current.handleTabDirtyChange(dirtyTabId, true));
    act(() => result.current.handlePreviewFileOpen('README.md'));

    expect(result.current.editorTabs).toHaveLength(2);
    expect(result.current.editorTabs[0].dirty).toBe(true);
    expect(result.current.editorTabs[0].fileStack.at(-1)?.path).toBe('docs/guide.md');
    expect(result.current.activeEditorTabId).not.toBe(dirtyTabId);
    expect(result.current.activeFilePath).toBe('README.md');
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

  it('closes multiple tabs atomically and selects the nearest remaining tab', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('one.txt'));
    act(() => result.current.handleFileOpen('two.txt'));
    act(() => result.current.handleFileOpen('three.txt'));
    act(() => result.current.handleFileOpen('four.txt'));

    const closingTabIds = result.current.editorTabs.slice(1, 3).map((tab) => tab.id);
    act(() => result.current.handleTabSelect(closingTabIds[0]));
    act(() => result.current.handleTabsClose(closingTabIds));

    expect(result.current.editorTabs.map((tab) => tab.fileStack[0].path)).toEqual([
      'one.txt',
      'four.txt',
    ]);
    expect(result.current.activeFilePath).toBe('four.txt');
  });

  it('clears the active file after closing all tabs', () => {
    const { result } = renderHook(() => useEditorSidebar({ selectedProject: project, isMobile: false }));

    act(() => result.current.handleFileOpen('one.txt'));
    act(() => result.current.handleFileOpen('two.txt'));
    act(() => result.current.handleTabsClose(result.current.editorTabs.map((tab) => tab.id)));

    expect(result.current.editorTabs).toEqual([]);
    expect(result.current.activeEditorTabId).toBeNull();
    expect(result.current.activeFilePath).toBeNull();
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

  it('updates and deletes Windows tabs when path casing differs', () => {
    const { result } = renderHook(() => useEditorSidebar({
      selectedProject: windowsProject,
      isMobile: false,
    }));

    act(() => result.current.handleFileOpen('docs/report.md'));
    const tabId = result.current.activeEditorTabId!;
    act(() => result.current.handleTabDirtyChange(tabId, true));
    act(() => result.current.handleFileRename('Docs/Report.md', 'Docs/Renamed.md'));

    expect(result.current.activeFilePath).toBe('Docs/Renamed.md');
    expect(result.current.editingFile?.renamedFromPath).toBe('docs/report.md');

    act(() => result.current.handleFileDelete('docs/RENAMED.md'));

    expect(result.current.editorTabs).toEqual([]);
    expect(result.current.activeFilePath).toBeNull();
  });
});
