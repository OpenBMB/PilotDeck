import { createRef, useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CodeEditorTab } from '../types/types';

const load = vi.hoisted(() => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  return { ready, release, requested, started, requests: 0, mounts: [] as string[] };
});
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { fileName?: string }) => key === 'loading' ? `Loading ${options?.fileName}` : key,
}) }));
vi.mock('./CodeEditor', async () => {
  load.requests++;
  load.started();
  await load.ready;
  return { default: ({ file, headerPrefix }: { file: { name: string }; headerPrefix: ReactNode }) => {
    const [draft, setDraft] = useState(file.name);
    useEffect(() => { load.mounts.push(file.name); }, []);
    return <>{headerPrefix}<input aria-label={`Draft ${file.name}`} value={draft} onChange={event => setDraft(event.target.value)} /></>;
  } };
});
vi.mock('./subcomponents/CodeEditorTabBar', () => ({
  default: ({ tabs, onClose }: { tabs: CodeEditorTab[]; onClose: (id: string) => void }) => <div>
    {tabs.map(tab => <button key={tab.id} onClick={() => onClose(tab.id)}>Close {tab.id}</button>)}
  </div>,
}));

const tab = (id: string): CodeEditorTab => ({ id, fileStack: [{ name: `${id}.txt`, path: `/${id}.txt` }], dirty: false });
const props = {
  isMobile: true, workspaceMode: true, editorExpanded: false, editorWidth: 600, hasManualWidth: false,
  resizeHandleRef: createRef<HTMLDivElement>(), onResizeStart: vi.fn(), onTabSelect: vi.fn(),
  onTabClose: vi.fn(), onTabsClose: vi.fn(), onTabDirtyChange: vi.fn(), onToggleEditorExpand: vi.fn(),
};
afterEach(() => { load.release(); cleanup(); load.mounts = []; vi.clearAllMocks(); });

it('keeps an unopened sidebar independent of editor loading and permits closing tabs before the module arrives', async () => {
  const module = import('./EditorSidebar');
  try {
    // An eager import blocks even the empty sidebar on the editor module.
    expect(await Promise.race([
      module.then(() => 'sidebar ready'), load.requested.then(() => 'editor required'),
    ])).toBe('sidebar ready');
    const { default: Sidebar } = await module;
    const { rerender, container } = render(<Sidebar {...props} editorTabs={[]} activeEditorTabId={null} />);
    expect(load.requests).toBe(0);
    rerender(<Sidebar {...props} editorTabs={[tab('first')]} activeEditorTabId="first" />);
    await waitFor(() => expect(load.requests).toBe(1));
    expect(screen.getByText('Loading first.txt')).toBeTruthy();
    rerender(<Sidebar {...props} editorTabs={[tab('second')]} activeEditorTabId="second" />);
    expect(screen.getByText('Loading second.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close second' }));
    expect(props.onTabClose).toHaveBeenCalledWith('second');
    rerender(<Sidebar {...props} editorTabs={[]} activeEditorTabId={null} />);
    await act(async () => { load.release(); await load.ready; });
    expect(container.innerHTML).toBe('');
    expect(load.mounts).toEqual([]);
  } finally {
    load.release();
    await module;
  }
});

it('keeps inactive editor instances and their unsaved text when switching tabs after loading', async () => {
  load.release();
  const { default: Sidebar } = await import('./EditorSidebar');
  const tabs = [tab('first'), tab('second')];
  const { rerender } = render(<Sidebar {...props} editorTabs={tabs} activeEditorTabId="first" />);
  const first = await screen.findByLabelText('Draft first.txt');
  fireEvent.change(first, { target: { value: 'unsaved first' } });
  rerender(<Sidebar {...props} editorTabs={tabs} activeEditorTabId="second" />);
  fireEvent.change(screen.getByLabelText('Draft second.txt'), { target: { value: 'unsaved second' } });
  rerender(<Sidebar {...props} editorTabs={tabs} activeEditorTabId="first" />);
  expect((screen.getByLabelText('Draft first.txt') as HTMLInputElement).value).toBe('unsaved first');
  expect((screen.getByLabelText('Draft second.txt') as HTMLInputElement).value).toBe('unsaved second');
  expect(load.mounts).toEqual(['first.txt', 'second.txt']);
});
