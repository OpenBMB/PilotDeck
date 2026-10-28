// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { GlobalSearchTarget } from '../../global-search/GlobalSearchContext';
import CodeEditor from './CodeEditor';

const state = vi.hoisted(() => ({
  context: null as { target: GlobalSearchTarget } | null,
  content: 'needle at the start\nsecond needle\nthe end',
  resolveRead: null as ((value: Response) => void) | null,
}));
vi.mock('../../global-search/GlobalSearchContext', () => ({ useGlobalSearch: () => state.context }));
vi.mock('../../../utils/api', () => ({ api: {
  readFile: vi.fn(async () => ({ ok: true, json: async () => ({ content: state.content }) })),
} }));
vi.mock('../hooks/useCodeEditorSettings', () => ({ useCodeEditorSettings: () => ({
  isDarkMode: false, wordWrap: false, minimapEnabled: false, showLineNumbers: true, fontSize: 14,
}) }));
vi.mock('../utils/editorExtensions', () => ({ getLanguageExtensions: () => [], createMinimapExtension: () => [], createScrollToFirstChunkExtension: () => [] }));
vi.mock('../utils/editorToolbarPanel', () => ({ createEditorToolbarPanelExtension: () => [] }));
vi.mock('./subcomponents/CodeEditorHeader', () => ({ default: ({ onToggleSearch }: { onToggleSearch?: () => void }) => <button onClick={onToggleSearch}>File search</button> }));
vi.mock('./subcomponents/CodeEditorFooter', () => ({ default: () => null }));
vi.mock('./subcomponents/CodeEditorBinaryFile', () => ({ default: () => null }));
vi.mock('./subcomponents/HtmlDocumentPreview', () => ({ default: () => null }));
vi.mock('./subcomponents/markdown/MarkdownPreview', () => ({ default: () => null }));
vi.mock('./subcomponents/FloatingFileSearchControls', () => ({ default: ({ query, onQueryChange, onNext }: {
  query: string; onQueryChange: (value: string) => void; onNext: () => void;
}) => <><input aria-label="Find in file" value={query} onChange={event => onQueryChange(event.target.value)} /><button onClick={onNext}>Next match</button></> }));

const file = { name: 'notes.txt', path: 'notes.txt', projectName: 'project' };
const target = (requestId: string, line = 1): GlobalSearchTarget => ({
  requestId, query: 'needle', id: 'hit', kind: 'files', project: { name: 'project', displayName: 'Project', fullPath: '/workspace' },
  path: 'notes.txt', title: 'notes.txt', line,
});
const props = { file, onClose: vi.fn(), projectPath: '/workspace', isSidebar: true };
const view = () => EditorView.findFromDOM(document.querySelector('.cm-content')!)!;
const selected = () => view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to);
const rangeMethods = ['getClientRects', 'getBoundingClientRect'] as const;
const originalRangeMethods = rangeMethods.map(name => Object.getOwnPropertyDescriptor(Range.prototype, name));

beforeEach(() => {
  state.context = { target: target('first') };
  state.content = 'needle at the start\nsecond needle\nthe end';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  rangeMethods.forEach((name, index) => {
    const original = originalRangeMethods[index];
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  });
});

describe('CodeEditor search navigation with a real CodeMirror editor', () => {
  it('navigates once, preserves typing and highlight updates, and accepts a new request for the same hit', async () => {
    const mounted = render(<CodeEditor {...props} />);
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy());
    await waitFor(() => expect(selected()).toBe('needle'));
    let expected = state.content;
    for (const text of [' one', ' two', ' three']) {
      expected += text;
      act(() => {
        const editor = view(), end = editor.state.doc.length;
        editor.dispatch({ selection: { anchor: end } });
        editor.dispatch(editor.state.replaceSelection(text));
      });
      await waitFor(() => expect(view().state.doc.toString()).toBe(expected));
      expect(view().state.selection.main.empty).toBe(true);
      expect(view().state.selection.main.head).toBe(view().state.doc.length);
      expect(document.querySelectorAll('.cm-searchMatch')).toHaveLength(2);
    }
    state.context = { target: target('second', 2) };
    mounted.rerender(<CodeEditor {...props} />);
    await waitFor(() => expect(selected()).toBe('needle'));
    expect(view().state.selection.main.from).toBe(state.content.lastIndexOf('needle'));
    // Removing matches may clamp the highlighted index, but must not move the caret.
    act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: 'edited without matches' }, selection: { anchor: 22 } }));
    await waitFor(() => expect(document.querySelectorAll('.cm-searchMatch')).toHaveLength(0));
    expect(view().state.selection.main.head).toBe(22);
    expect(view().state.selection.main.empty).toBe(true);
  });

  it('waits for file loading and does not replay consumed navigation when the tab becomes active again', async () => {
    const { api } = await import('../../../utils/api');
    vi.mocked(api.readFile).mockImplementationOnce(() => new Promise(resolve => { state.resolveRead = resolve; }));
    const mounted = render(<CodeEditor {...props} />);
    expect(document.querySelector('.cm-content')).toBeNull();
    await act(async () => state.resolveRead!(new Response(JSON.stringify({ content: state.content }))));
    await waitFor(() => expect(selected()).toBe('needle'));
    act(() => view().dispatch({ selection: { anchor: view().state.doc.length } }));
    mounted.rerender(<CodeEditor {...props} isActive={false} />);
    mounted.rerender(<CodeEditor {...props} isActive />);
    expect(view().state.selection.main.head).toBe(view().state.doc.length);
    expect(view().state.selection.main.empty).toBe(true);
  });

  it('retains explicit next-match navigation in standalone file search without jumping on edits', async () => {
    state.context = null;
    render(<CodeEditor {...props} />);
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'File search' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in file' }), { target: { value: 'needle' } });
    await waitFor(() => expect(selected()).toBe('needle'));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(view().state.selection.main.from).toBe(state.content.lastIndexOf('needle'));
    act(() => {
      view().dispatch({ selection: { anchor: view().state.doc.length } });
      view().dispatch(view().state.replaceSelection(' typed'));
    });
    expect(view().state.selection.main.head).toBe(view().state.doc.length);
    expect(view().state.selection.main.empty).toBe(true);
  });

  it('waits for the new document when an existing editor switches files', async () => {
    const mounted = render(<CodeEditor {...props} />);
    await waitFor(() => expect(selected()).toBe('needle'));
    const { api } = await import('../../../utils/api');
    vi.mocked(api.readFile).mockImplementationOnce(() => new Promise(resolve => { state.resolveRead = resolve; }));
    const nextContent = 'different first line\na much longer prefix needle\nend';
    state.context = { target: { ...target('new-file', 2), path: 'other.txt' } };
    const nextProps = { ...props, file: { ...file, name: 'other.txt', path: 'other.txt' } };
    mounted.rerender(<CodeEditor {...nextProps} />);
    await act(async () => state.resolveRead!(new Response(JSON.stringify({ content: nextContent }))));
    await waitFor(() => expect(selected()).toBe('needle'));
    expect(view().state.selection.main.from).toBe(nextContent.indexOf('needle'));
  });
});
