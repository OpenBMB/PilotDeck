// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import GlobalSearchDialog from './GlobalSearchDialog';
import { GlobalSearchProvider, useGlobalSearch, type GlobalSearchResult } from './GlobalSearchContext';
import { useRegisterFindShortcutTarget } from '../../contexts/FindShortcutContext';
import strings from '../../i18n/locales/en/common.json';
import type { Project } from '../../types/app';
import { readRecentFiles, recordRecentFile } from './recentFiles';

const { searchApi, fileMetadata } = vi.hoisted(() => ({ searchApi: vi.fn(), fileMetadata: vi.fn() }));
vi.mock('../../utils/api', () => ({ api: { globalSearch: searchApi, fileMetadata } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => {
  return key.split('.').reduce((value: unknown, part) => (value as Record<string, unknown>)?.[part], strings) || key;
} }) }));
vi.mock('lucide-react', () => {
  const Icon = () => <svg />;
  return { ArrowUpRight: Icon, Check: Icon, ChevronDown: Icon, ChevronRight: Icon, Clock3: Icon, FileText: Icon, Folder: Icon, FolderOpen: Icon, Layers: Icon, Loader2: Icon,
    Image: Icon, Video: Icon, MessageSquare: Icon, Search: Icon, Trash2: Icon, X: Icon };
});

const project = { name: 'project', displayName: 'Example', fullPath: '/workspace', sessions: [] };
const result: GlobalSearchResult = { id: 'hit', kind: 'chats', matchType: 'content', title: 'Historical chat',
  project, sessionId: 'old', entryId: 'entry-42', snippet: 'A needle in old history', timestamp: '2026-10-27T08:00:00Z' };
const response = (items: GlobalSearchResult[] = [result]) => ({
  groups: { chats: items, files: [] },
  counts: { chats: items.length, files: 0 },
  hasMore: { chats: false, files: false }, partial: [],
});

const defaultProjects = [project];
function Harness({ onSelect = vi.fn(), localFind = vi.fn(), projects = defaultProjects }: {
  onSelect?: (result: GlobalSearchResult, query: string) => void; localFind?: () => void; projects?: Project[];
}) {
  const search = useGlobalSearch();
  const file = useRef<HTMLDivElement>(null);
  useRegisterFindShortcutTarget({ scope: 'file', containerRef: file, onOpen: localFind });
  return <><button onClick={search?.open}>Search entry</button><div ref={file}><button>File surface</button></div>
    <GlobalSearchDialog projects={projects} onSelect={onSelect} /></>;
}
const mount = (props = {}) => render(<GlobalSearchProvider><Harness {...props} /></GlobalSearchProvider>);

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  searchApi.mockResolvedValue({ ok: true, json: async () => response() });
  fileMetadata.mockReset().mockResolvedValue({ ok: true, status: 200 });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('global search', () => {
  it('offers only All, Chats and Files, with the project kept as a scope filter', () => {
    mount(); fireEvent.click(screen.getByText('Search entry'));
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['All', 'Chats', 'Files']);
    const scope = screen.getByRole('button', { name: 'Search scope: All projects' });
    expect(scope.closest('.global-search-input-row')).toBeTruthy();
  });

  it('has no tab-row close button and clears the query from beside the input', () => {
    mount(); fireEvent.click(screen.getByText('Search entry'));
    expect(screen.queryByRole('button', { name: 'Close search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    const input = screen.getByRole('combobox', { name: /Search chats/ });
    fireEvent.change(input, { target: { value: '你好' } });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.parentElement).toBe(input.closest('.global-search-query-area'));
    fireEvent.click(clear);
    expect((input as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(input);
    fireEvent.mouseDown(document.querySelector('.global-search-overlay')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows recent files with chat/history groups and opens a recent file without a stale search target', async () => {
    localStorage.setItem('pilotdeck:global-search-history', JSON.stringify(['previous query']));
    recordRecentFile('local', { projectName: project.name, path: 'docs/guide.md', visitedAt: 1 });
    const onSelect = vi.fn();
    mount({ onSelect, projects: [{ ...project, sessions: [{ id: 'recent-chat', title: 'Recent chat' }] }] });
    fireEvent.click(screen.getByText('Search entry'));
    const list = screen.getByRole('listbox', { name: 'Search results' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    expect(screen.getByText('Recent chats')).toBeTruthy();
    expect(screen.getByText('Recently opened files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'previous query' })).toBeTruthy();
    const file = within(list).getByRole('option', { name: /guide.md/ });
    expect(file.querySelector('.global-search-snippet')).toBeNull();
    expect(file.title).toBe('docs/guide.md');
    expect(within(file).getByText('Example')).toBeTruthy();
    const input = screen.getByRole('combobox', { name: /Search chats/ });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'files', path: 'docs/guide.md' }), '');
    expect(onSelect.mock.calls[0][0].line).toBeUndefined();
    expect(searchApi).not.toHaveBeenCalled();
  });

  it('limits recent files to five, refills deleted entries, filters by project and retains transient failures', async () => {
    const other = { ...project, name: 'other', displayName: 'Other' };
    for (let index = 1; index <= 7; index++) recordRecentFile('local', { projectName: other.name, path: index + '.md', visitedAt: 10 + index });
    recordRecentFile('local', { projectName: project.name, path: 'mine.md', visitedAt: 1 });
    fileMetadata.mockImplementation(async (_project: string, path: string) => {
      if (path === '7.md') return { ok: false, status: 404 };
      if (path === '6.md') throw new Error('offline');
      return { ok: true, status: 200 };
    });
    mount({ projects: [project, other] }); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    const list = screen.getByRole('listbox', { name: 'Search results' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    expect(within(list).queryByRole('option', { name: /7.md/ })).toBeNull();
    expect(readRecentFiles('local').some(file => file.path === '7.md')).toBe(false);
    expect(readRecentFiles('local').some(file => file.path === '6.md')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Search scope: All projects' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Search scope' })).getByRole('option', { name: 'Example' }));
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    expect(within(list).getByRole('option', { name: /mine.md/ })).toBeTruthy();
  });

  it('shows a clear empty state for files and never issues an empty search', () => {
    mount(); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByText('Recently opened files')).toBeTruthy();
    expect(screen.getByText('No recently opened files yet')).toBeTruthy();
    expect(searchApi).not.toHaveBeenCalled();
    expect(fileMetadata).not.toHaveBeenCalled();
  });

  it('uses Control/Command+F everywhere, taking precedence over local file search', () => {
    const localFind = vi.fn(); mount({ localFind });
    fireEvent.keyDown(screen.getByText('File surface'), { key: 'f', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Search PilotDeck' })).toBeTruthy();
    expect(localFind).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Search chats/ }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('dismisses the project popup on Tab and outside clicks while keeping the search dialog open', () => {
    mount(); fireEvent.click(screen.getByText('Search entry'));
    const scope = screen.getByRole('button', { name: 'Search scope: All projects' });
    const input = screen.getByRole('combobox', { name: /Search chats/ });
    fireEvent.click(scope);
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search scope' }), { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('listbox', { name: 'Search scope' })).toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.click(scope);
    fireEvent.pointerDown(input);
    expect(screen.queryByRole('listbox', { name: 'Search scope' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('highlights literal matches and passes stable message identity when opened with Enter', async () => {
    const onSelect = vi.fn(); mount({ onSelect }); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.change(screen.getByRole('combobox', { name: /Search chats/ }), { target: { value: 'needle' } });
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy());
    expect(within(screen.getByRole('listbox')).getByRole('option').querySelector('mark')?.textContent).toBe('needle');
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Search chats/ }), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(result, 'needle');
    expect(JSON.parse(localStorage.getItem('pilotdeck:global-search-history') || '[]')).toEqual(['needle']);
  });

  it('debounces input, aborts obsolete requests and prevents stale responses replacing the latest query', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    searchApi.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    mount(); fireEvent.click(screen.getByText('Search entry'));
    const input = screen.getByRole('combobox', { name: /Search chats/ });
    fireEvent.change(input, { target: { value: 'old' } });
    await waitFor(() => expect(searchApi).toHaveBeenCalledTimes(1));
    const signal = searchApi.mock.calls[0][1].signal as AbortSignal;
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy());
    expect(signal.aborted).toBe(true);
    resolveOld({ ok: true, json: async () => response([{ ...result, title: 'Stale result' }]) });
    await waitFor(() => expect(screen.queryByText('Stale result')).toBeNull());
    expect(screen.getByText('Historical chat')).toBeTruthy();
  });

  it('waits until Chinese composition finishes and ignores the composition Enter', async () => {
    const onSelect = vi.fn(); mount({ onSelect }); fireEvent.click(screen.getByText('Search entry'));
    const input = screen.getByRole('combobox', { name: /Search chats/ });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '搜索' } });
    expect(searchApi).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: '搜索' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(searchApi).toHaveBeenCalledWith(expect.objectContaining({ query: '搜索' }), expect.anything()));
  });

  it('shows failures with retry and supports changing the project scope', async () => {
    searchApi.mockRejectedValueOnce(new Error('network')); mount(); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.change(screen.getByRole('combobox', { name: /Search chats/ }), { target: { value: 'needle' } });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(screen.getByRole('listbox')).getByRole('option')).toBeTruthy());
    const scope = screen.getByRole('button', { name: 'Search scope: All projects' });
    fireEvent.click(scope);
    fireEvent.keyDown(within(screen.getByRole('listbox', { name: 'Search scope' })).getByRole('option', { name: 'All projects' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Search scope' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(scope, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search scope' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search scope' }), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Search scope: Example' })).toBeTruthy();
    await waitFor(() => expect(searchApi).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: 'project' }), expect.anything()));
  });

  it('shows the chat title, content snippet and project together in one result', async () => {
    mount(); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.change(screen.getByRole('combobox', { name: /Search chats/ }), { target: { value: 'needle' } });
    const option = await within(screen.getByRole('listbox')).findByRole('option');
    expect(within(option).getByText('Historical chat')).toBeTruthy();
    expect(option.textContent).toContain('A needle in old history');
    expect(within(option).getByText('Example')).toBeTruthy();
  });

  it.each([{ name: 'needle.md', snippetVisible: false }, { name: 'guide.md', snippetVisible: true }])(
    'presents $name compactly while retaining a body-only snippet and the original navigation target', async ({ name, snippetVisible }) => {
    const file: GlobalSearchResult = { id: 'file-hit', kind: 'files', title: name, project,
      snippet: 'The needle document content', path: 'docs/' + name, line: 12 };
    searchApi.mockResolvedValue({ ok: true, json: async () => ({ groups: { chats: [], files: [file] },
      counts: { chats: 0, files: 1 }, hasMore: { chats: false, files: false }, partial: [] }) });
    const onSelect = vi.fn(); mount({ onSelect }); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    fireEvent.change(screen.getByRole('combobox', { name: /Search chats/ }), { target: { value: 'needle' } });
    const option = await within(screen.getByRole('listbox')).findByRole('option');
    expect(option.textContent).toContain(name);
    expect(option.textContent?.includes('The needle document content')).toBe(snippetVisible);
    expect(option.title).toBe('docs/' + name + ':12');
    expect(within(option).getByText('Example')).toBeTruthy();
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(file, 'needle');
  });

  it('expands an All group and paginates chats without repeating existing rows', async () => {
    const chats = Array.from({ length: 31 }, (_, index) => ({ ...result, id: 'chat-' + index,
      sessionId: 'session-' + index, title: 'Chat ' + index }));
    searchApi.mockImplementation(async ({ offset = 0 }) => ({ ok: true, json: async () => ({
      groups: { chats: chats.slice(offset, offset + 30), files: [] },
      counts: { chats: 31, files: 0 }, hasMore: { chats: offset === 0, files: false }, partial: [],
    }) }));
    mount(); fireEvent.click(screen.getByText('Search entry'));
    fireEvent.change(screen.getByRole('combobox', { name: /Search chats/ }), { target: { value: 'needle' } });
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(5));
    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(30));
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(31));
    expect(searchApi).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'chats', offset: 30 }), expect.anything());
  });
});

it('preserves the selected result identity as streamed results are inserted ahead of it', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  searchApi.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
    { headers: { 'content-type': 'text/event-stream' } }));
  const onSelect = vi.fn(); mount({ onSelect }); fireEvent.click(screen.getByText('Search entry'));
  const input = screen.getByRole('combobox', { name: /Search chats/ });
  fireEvent.change(input, { target: { value: 'needle' } });
  await waitFor(() => expect(searchApi).toHaveBeenCalledTimes(1));
  const second = { ...result, id: 'second', title: 'Second choice' };
  stream!.enqueue(encoder.encode('event: snapshot\ndata: ' + JSON.stringify(response([result, second])) + '\n\n'));
  await waitFor(() => expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2));
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  stream!.enqueue(encoder.encode('event: done\ndata: ' + JSON.stringify(response([{ ...result, id: 'new', title: 'New first result' }, result, second])) + '\n\n'));
  stream!.close();
  await waitFor(() => expect(screen.getByText('New first result')).toBeTruthy());
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(second, 'needle');
});
