import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Clock, Eye, EyeOff, Folder, FolderPlus, HardDrive, Home, Loader2, Search, Star, X } from 'lucide-react';
import { useAuth } from '../../auth/context/AuthContext';
import { browseFilesystemFolders, createFolderInFilesystem } from '../data/workspaceApi';
import { getParentPath, joinFolderPath } from '../utils/pathUtils';
import { isImeEnterEvent } from '../../../utils/ime';
import './FolderBrowserModal.css';

type Props = { isOpen: boolean; initialPath?: string; autoAdvanceOnSelect: boolean; onClose: () => void; onFolderSelected: (path: string, advance: boolean) => void };
type Column = Awaited<ReturnType<typeof browseFilesystemFolders>>;
type Preferences = { recent: string[]; favorites: string[] };
const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const ancestors = (path: string) => {
  const paths: string[] = [];
  let item: string | null = path;
  while (item && !paths.includes(item)) { paths.unshift(item); item = getParentPath(item); }
  return paths;
};
function readPreferences(key: string): Preferences {
  try {
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const paths = (value: unknown) => Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string').slice(0, 12) : [];
    return { recent: paths(data.recent), favorites: paths(data.favorites) };
  } catch { return { recent: [], favorites: [] }; }
}

export default function FolderBrowserModal(props: Props) {
  return props.isOpen ? <FolderPicker {...props} /> : null;
}

function FolderPicker({ initialPath, autoAdvanceOnSelect, onClose, onFolderSelected }: Props) {
  const { t } = useTranslation();
  const label = (key: string) => t(`projectWizard.folderBrowser.${key}`);
  const { user } = useAuth();
  const storageKey = `pilotdeck.folder-picker.v1:${user?.id ?? 'local'}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey));
  const [columns, setColumns] = useState<Column[]>([]);
  const [home, setHome] = useState<Column>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [address, setAddress] = useState('');
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 });
  const cache = useRef(new Map<string, Column>());
  const sequence = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const breadcrumbs = useRef<HTMLElement>(null);
  const focusAfterNavigation = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const current = columns[columns.length - 1];
  const currentPath = current?.path || '';
  const titleId = useId();
  const latest = useRef({ onClose, creating });
  latest.current = { onClose, creating };
  const root = current?.rootsPath || '/';
  const driveView = currentPath === current?.rootsPath || current?.suggestions.some(f => f.type === 'drive');

  const persist = (next: Preferences) => {
    setPreferences(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Browsing works without storage. */ }
  };
  const read = async (path: string) => {
    const saved = cache.current.get(path);
    if (saved) return saved;
    const data = await browseFilesystemFolders(path, true);
    cache.current.set(path, data); cache.current.set(data.path, data);
    if (cache.current.size > 48) cache.current.delete(cache.current.keys().next().value!);
    return data;
  };
  const navigate = async (path: string, parentColumns?: Column[], historyIndex?: number) => {
    const request = ++sequence.current;
    setBusy(true); setError('');
    try {
      const data = await read(path);
      let next = parentColumns;
      if (!next) {
        const parent = getParentPath(data.path);
        try { next = parent ? [await read(parent)] : []; } catch { next = []; }
      }
      if (sequence.current !== request) return false;
      setColumns([...next, data]); setSearch(''); setEditingPath(false); setAddress(data.path); setNewFolder(null);
      setHistory(previous => historyIndex !== undefined ? { ...previous, index: historyIndex } : previous.paths[previous.index] === data.path ? previous : { paths: [...previous.paths.slice(0, previous.index + 1), data.path], index: previous.index + 1 });
      return true;
    } catch {
      if (sequence.current === request) setError(label('loadFailed'));
      return false;
    } finally { if (sequence.current === request) setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    const initialSequence = sequence.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    searchInput.current?.focus();
    void read('~').then(async data => {
      if (!active) return;
      setHome(data);
      if (sequence.current !== initialSequence) return;
      const ok = await navigate(initialPath?.trim() || preferences.recent[0] || data.path);
      if (!ok && active && sequence.current === initialSequence + 1) await navigate(data.path, []);

    }).catch(() => { if (active) { setBusy(false); setError(label('loadFailed')); } });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!latest.current.creating) latest.current.onClose();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault(); setEditingPath(true);
      }
      if (event.key === 'Tab') {
        const all = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []).filter(e => e.getClientRects().length > 0);
        const first = all[0], last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { active = false; sequence.current++; document.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
    if (focusAfterNavigation.current === currentPath) {
      const column = scroller.current?.querySelector<HTMLElement>('.is-current');
      (column?.querySelector<HTMLElement>('.folder-picker-entries button') || column)?.focus();
      focusAfterNavigation.current = null;
    }
  }, [columns, currentPath]);
  useEffect(() => {
    if (breadcrumbs.current) breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [currentPath, editingPath]);

  const choose = () => {
    if (!currentPath || busy || creating || driveView) return;
    persist({ ...preferences, recent: [currentPath, ...preferences.recent.filter(p => p !== currentPath)].slice(0, 8) });
    onFolderSelected(currentPath, autoAdvanceOnSelect);
  };
  const create = async () => {
    if (!newFolder?.trim() || creating || /[\\/]/.test(newFolder) || ['.', '..'].includes(newFolder.trim())) return;
    setCreating(true); setError('');
    try {
      const path = await createFolderInFilesystem(joinFolderPath(currentPath, newFolder));
      cache.current.clear();
      await navigate(path);
    } catch { setError(label('createFailed')); }
    finally { setCreating(false); }
  };
  const shortcut = (path: string, name: string, icon: React.ReactNode) => <button key={path} type="button" className={currentPath === path ? 'is-selected' : ''} title={path} disabled={creating} onClick={() => void navigate(path)}>{icon}<span>{name}</span></button>;
  const common = home?.suggestions.filter(f => ['desktop', 'documents', 'downloads', 'workspace', 'projects', '桌面', '文档', '下载'].includes(f.name.toLowerCase())) || [];
  const toolbarButton = (key: string, icon: React.ReactNode, action: () => void, disabled = false, pressed?: boolean) => <button type="button" title={label(key)} aria-label={label(key)} aria-pressed={pressed} onClick={action} disabled={disabled || creating}>{icon}</button>;

  return createPortal(<div data-modal-overlay className="folder-picker-overlay">
    <div ref={panel} className="folder-picker" role="dialog" data-dialog-surface aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.altKey && event.key === 'ArrowUp' && currentPath && !creating) { event.preventDefault(); const parent = getParentPath(currentPath); if (parent) void navigate(parent); }
    }}>
      <header className="folder-picker-header"><Folder size={19} /><h2 id={titleId}>{label('title')}</h2>{toolbarButton('close', <X />, onClose)}</header>
      <div className="folder-picker-toolbar">
        <div className="folder-picker-navigation">
          {toolbarButton('back', <ArrowLeft />, () => void navigate(history.paths[history.index - 1], undefined, history.index - 1), history.index <= 0 || busy)}
          {toolbarButton('forward', <ArrowRight />, () => void navigate(history.paths[history.index + 1], undefined, history.index + 1), history.index >= history.paths.length - 1 || busy)}
          {toolbarButton('up', <ArrowUp />, () => { const parent = getParentPath(currentPath); if (parent) void navigate(parent); }, !currentPath || !getParentPath(currentPath) || busy)}
        </div>
        <div className="folder-picker-address">
          {editingPath ? <input aria-label={label('address')} value={address} autoFocus onFocus={e => e.target.select()} onChange={e => setAddress(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !isImeEnterEvent(e) && address.trim()) void navigate(address.trim());
            if (e.key === 'Escape') { e.stopPropagation(); setEditingPath(false); setAddress(currentPath); }
          }} /> : <nav ref={breadcrumbs} aria-label={label('path')}>
            {ancestors(currentPath).map((path, i) => <span key={path}>{i > 0 && <ChevronRight size={12} />}<button disabled={creating} title={path} onClick={() => void navigate(path)}>{basename(path)}</button></span>)}
            <button className="folder-picker-edit-path" onClick={() => { setAddress(currentPath); setEditingPath(true); }} title={label('address')} aria-label={label('address')}>…</button>
          </nav>}
        </div>
        <label className="folder-picker-search"><Search size={15} /><input ref={searchInput} aria-label={label('search')} placeholder={label('search')} value={search} onChange={e => setSearch(e.target.value)} /></label>
        {toolbarButton(hidden ? 'hideHidden' : 'showHidden', hidden ? <Eye /> : <EyeOff />, () => setHidden(!hidden), false, hidden)}
        {toolbarButton('createFolder', <FolderPlus />, () => setNewFolder(newFolder === null ? '' : null), !currentPath || !!driveView || busy)}
      </div>
      <div className="folder-picker-content">
        <aside className="folder-picker-shortcuts">
          <h3>{label('locations')}</h3>
          {home && shortcut(home.path, label('home'), <Home />)}
          {common.map(f => shortcut(f.path, f.name, <Folder />))}
          {shortcut(root, label(current?.rootsPath ? 'drives' : 'filesystem'), <HardDrive />)}
          <h3>{label('favorites')}</h3>
          {preferences.favorites.map(path => shortcut(path, basename(path), <Star />))}
          <h3>{label('recent')}</h3>
          {preferences.recent.map(path => shortcut(path, basename(path), <Clock />))}
        </aside>
        <main className="folder-picker-main">
          {newFolder !== null && <form className="folder-picker-new" onSubmit={e => { e.preventDefault(); void create(); }}>
            <FolderPlus size={17} /><input aria-label={label('newFolderName')} autoFocus placeholder={label('newFolderName')} value={newFolder} disabled={creating} onChange={e => setNewFolder(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && isImeEnterEvent(e)) e.preventDefault(); if (e.key === 'Escape') { e.stopPropagation(); setNewFolder(null); } }} />
            <button type="submit" disabled={creating || !newFolder.trim() || /[\\/]/.test(newFolder) || ['.', '..'].includes(newFolder.trim())}>{label('create')}</button>
            <button type="button" disabled={creating} onClick={() => setNewFolder(null)} aria-label={label('cancel')}><X size={16} /></button>
          </form>}
          {error && <p className="folder-picker-error" role="alert">{error}</p>}
          <div ref={scroller} className="folder-picker-columns" aria-busy={busy}>
            {columns.map((column, index) => {
              const last = index === columns.length - 1;
              const folders = column.suggestions.filter(f => (hidden || !f.name.startsWith('.')) && (!last || f.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
              return <section key={column.path} tabIndex={-1} className={`folder-picker-column${last ? ' is-current' : ''}`} aria-label={column.path}>
                <div className="folder-picker-column-title" title={column.path}>{basename(column.path)}</div>
                <div className="folder-picker-entries" onKeyDown={e => {
                  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
                  const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next = e.key === 'ArrowDown' ? Math.min(focused + 1, buttons.length - 1) : e.key === 'ArrowUp' ? Math.max(focused - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
                  if (next >= 0) { e.preventDefault(); buttons[next]?.focus(); }
                  if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); const target = scroller.current?.children[index - 1]?.querySelector<HTMLButtonElement>('button[aria-current=true]'); target?.focus(); }
                  if ((e.key === 'ArrowRight' || e.key === 'Enter') && focused >= 0 && !isImeEnterEvent(e)) {
                    e.preventDefault(); focusAfterNavigation.current = folders[focused].path; buttons[focused].click();
                  }
                }}>
                  {folders.map(folder => <button type="button" key={folder.path} title={folder.path} aria-current={columns[index + 1]?.path === folder.path ? 'true' : undefined} disabled={creating} onClick={() => void navigate(folder.path, columns.slice(0, index + 1))}>
                    {folder.type === 'drive' ? <HardDrive /> : <Folder />}<span>{folder.name}</span><ChevronRight className="folder-picker-chevron" />
                  </button>)}
                  {!folders.length && <p className="folder-picker-empty">{label(search && last ? 'noMatches' : 'noSubfolders')}</p>}
                </div>
              </section>;
            })}
            {busy && <div className="folder-picker-loading" role="status" aria-label={label('loading')}><Loader2 className="animate-spin" size={20} /></div>}
          </div>
        </main>
      </div>
      <footer className="folder-picker-footer">
        <div className="folder-picker-selection"><span>{label('path')}</span><code data-current-path title={currentPath}>{currentPath || '—'}</code>
          {toolbarButton(preferences.favorites.includes(currentPath) ? 'unfavorite' : 'favorite', <Star fill={preferences.favorites.includes(currentPath) ? 'currentColor' : 'none'} />, () => persist({ ...preferences, favorites: preferences.favorites.includes(currentPath) ? preferences.favorites.filter(p => p !== currentPath) : [...preferences.favorites, currentPath].slice(-12) }), !currentPath || !!driveView)}
        </div>
        <div className="folder-picker-actions"><button type="button" disabled={creating} onClick={onClose}>{label('cancel')}</button><button className="folder-picker-confirm" type="button" disabled={!currentPath || busy || creating || !!driveView} onClick={choose}>{label('useThisFolder')}</button></div>
      </footer>
    </div>
  </div>, document.body);
}
