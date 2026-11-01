import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Clock3, Folder, Loader2, MessageSquare, Search, Trash2, X } from 'lucide-react';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { getSearchNameOverrides, projectDisplayName, sessionDisplayTitle, useCustomNamesVersion } from '../../lib/customNames';
import { isImeCompositionEvent } from '../../utils/ime';
import { findTextSearchMatches } from '../code-editor/utils/fileSearch';
import { getFileIconData } from '../file-tree/constants/fileIcons';
import { SEARCH_KINDS, useGlobalSearch, type GlobalSearchResult, type SearchKind } from './GlobalSearchContext';
import './global-search.css';
import { readSearchResponse } from './searchStream';
import ProjectScopePicker from './ProjectScopePicker';
import { useRecentFileResults } from './useRecentFileResults';

type Results = {
  groups: Record<SearchKind, GlobalSearchResult[]>;
  counts: Record<SearchKind, number>;
  hasMore: Record<SearchKind, boolean>;
  partial: string[];
  pending?: Partial<Record<SearchKind, boolean>>;
};
const HISTORY_KEY = 'pilotdeck:global-search-history';
const PAGE_SIZE = 30;

export function HighlightedSearchText({ text, query }: { text: string; query: string }) {
  const matches = findTextSearchMatches(text, query);
  const parts = [];
  let end = 0;
  for (const match of matches) {
    parts.push(text.slice(end, match.from), <mark key={match.from}>{text.slice(match.from, match.to)}</mark>);
    end = match.to;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}

function readHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : [];
  } catch { return []; }
}

function SearchResultRow({ result, query, id, index, active, onHover, onSelect }: {
  result: GlobalSearchResult; query: string; id: string; index: number; active: boolean;
  onHover: () => void; onSelect: () => void;
}) {
  const isFile = result.kind === 'files';
  const fileIcon = isFile ? getFileIconData(result.title) : null;
  const Icon = fileIcon?.icon || MessageSquare;
  const projectName = projectDisplayName(result.project);
  const filePath = result.path ? result.path + (result.line ? ':' + result.line : '') : '';
  const nameMatches = Boolean(query.trim() && findTextSearchMatches(result.title, query).length);
  // Keep the reason for a body/path-only hit visible; name hits stay compact.
  const secondary = isFile ? !query.trim() || nameMatches ? '' : result.snippet || filePath : result.snippet;
  return <button id={id} type="button" role="option" aria-selected={active}
    data-search-result-index={index} title={isFile ? filePath : result.title}
    className={'global-search-result ' + (isFile ? 'global-search-file-result' : 'global-search-chat-result') + (secondary ? ' has-snippet' : '')}
    onMouseEnter={onHover} onClick={onSelect}>
    <span className="global-search-result-icon">
      {fileIcon?.asset ? <img src={fileIcon.asset} width={32} height={32} alt="" aria-hidden />
        : <Icon size={isFile ? 27 : 17} strokeWidth={1.6} className={fileIcon?.color} aria-hidden />}
    </span>
    <span className="global-search-result-content">
      <span className="global-search-result-heading">
        <span className="global-search-result-title"><HighlightedSearchText text={result.title} query={query} /></span>
      </span>
      {secondary ? <span className="global-search-snippet"><HighlightedSearchText text={secondary} query={query} /></span> : null}
    </span>
    <span className="global-search-result-project" title={projectName}>
      <Folder size={13} strokeWidth={1.5} aria-hidden /><span><HighlightedSearchText text={projectName} query={query} /></span>
    </span>
  </button>;
}

export default function GlobalSearchDialog({ projects, onSelect }: {
  projects: Project[];
  onSelect: (result: GlobalSearchResult, query: string) => void;
}) {
  const search = useGlobalSearch();
  const { t } = useTranslation('common');
  const id = useId();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<SearchKind | 'all'>('all');
  const [projectName, setProjectName] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [history, setHistory] = useState(readHistory);
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composingEndedAt = useRef(0);
  const namesVersion = useCustomNamesVersion();
  const label = (name: SearchKind | 'all') => t('globalSearch.' + name);
  const isOpen = Boolean(search?.isOpen);
  const close = search?.close;
  const trimmed = committedQuery.trim();
  const visibleGroups = useMemo(() => (kind === 'all' ? [...SEARCH_KINDS] : [kind as SearchKind]).map(name => ({
    kind: name, items: results?.groups[name]?.slice(0, kind === 'all' ? 5 : undefined) || [],
  })), [kind, results]);
  const recent = useMemo<GlobalSearchResult[]>(() => projects.filter(project => !projectName || project.name === projectName).flatMap(project => (project.sessions || []).slice(0, 2).map(session => ({
    id: 'recent:' + project.name + ':' + session.id, kind: 'chats' as const, project,
    matchType: 'title' as const, title: sessionDisplayTitle(session), sessionId: session.id,
    timestamp: session.lastActivity || session.createdAt || '',
  }))).sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)).slice(0, 5), [projects, projectName]);
  const recentFiles = useRecentFileResults(projects, projectName, isOpen && !trimmed && kind !== 'chats');
  const recentGroups = (kind === 'all' ? [...SEARCH_KINDS] : [kind]).map(name => ({
    kind: name, items: name === 'chats' ? recent : recentFiles.items,
  }));
  const flat = trimmed ? visibleGroups.flatMap(group => group.items) : recentGroups.flatMap(group => group.items);
  const activeIndex = Math.max(0, flat.findIndex(result => result.id === activeResultId));
  const total = results ? visibleGroups.reduce((sum, group) => sum + results.counts[group.kind], 0) : 0;

  useEffect(() => {
    if (!composing) setCommittedQuery(query);
  }, [query, composing]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, [isOpen]);

  useEffect(() => {
    setActiveResultId(null); setOffset(0); setResults(null);
    if (list.current) list.current.scrollTop = 0;
  }, [trimmed, kind, projectName]);

  useEffect(() => {
    if (!isOpen || !trimmed) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(false);
    const timer = setTimeout(async () => {
      try {
        const response = await api.globalSearch({ query: trimmed, kind, projectName, limit: PAGE_SIZE, offset, stream: true,
          ...getSearchNameOverrides() }, { signal: controller.signal });
        await readSearchResponse<Results>(response, next => {
          if (!controller.signal.aborted) setResults(previous => {
            if (!offset || !previous || kind === 'all') return next;
            const items = new Map([...previous.groups[kind], ...next.groups[kind]].map(item => [item.id, item]));
            return { ...next, groups: { ...next.groups, [kind]: [...items.values()] } };
          });
        }, controller.signal);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [isOpen, trimmed, kind, projectName, namesVersion, retry, offset]);

  useEffect(() => {
    if (!flat.length) return;
    if (!activeResultId || !flat.some(result => result.id === activeResultId)) setActiveResultId(flat[0].id);
  }, [flat, activeResultId]);

  useEffect(() => {
    panel.current?.querySelector('[data-search-result-index="' + activeIndex + '"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const remember = (value: string) => {
    const updated = [value, ...history.filter(item => item !== value)].slice(0, 8);
    setHistory(updated);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch { /* Storage may be unavailable. */ }
  };
  const choose = (result: GlobalSearchResult) => {
    if (trimmed) remember(trimmed);
    onSelect(result, trimmed);
  };
  const row = (result: GlobalSearchResult, index: number) => <SearchResultRow key={result.id}
    result={result} query={trimmed} id={id + '-result-' + index} index={index} active={index === activeIndex}
    onHover={() => setActiveResultId(result.id)} onSelect={() => choose(result)} />;

  if (!isOpen) return null;
  let resultIndex = 0;
  return createPortal(
    <div className="global-search-overlay" data-modal-overlay onMouseDown={event => {
      if (event.target === event.currentTarget) close?.();
    }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-label={t('globalSearch.title')}
        data-global-search className="global-search-dialog" onKeyDown={event => {
          if (isImeCompositionEvent(event) || composing) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close?.(); }
          const navigatingResults = event.target === input.current
            || (event.target instanceof Element && Boolean(event.target.closest('[data-search-result-index]')));
          if (navigatingResults && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            if (flat.length) setActiveResultId(flat[(activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length].id);
          }
          if (event.key === 'Enter' && event.target === input.current && Date.now() - composingEndedAt.current > 150) {
            event.preventDefault();
            if (flat[activeIndex]) choose(flat[activeIndex]);
            else if (trimmed) remember(trimmed);
          }
          if (event.key === 'Tab') {
            const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') || []);
            const first = focusable[0]; const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="global-search-input-row">
          <Search size={19} strokeWidth={1.6} aria-hidden />
          <div className="global-search-query-area" onMouseDown={event => {
            if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); }
          }}>
            <span className="global-search-query-field" data-has-query={Boolean(query)}>
              <span className="global-search-query-measure" aria-hidden>{query || t('globalSearch.placeholder')}</span>
              <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded={Boolean(trimmed || flat.length)}
                aria-controls={id + '-results'} aria-activedescendant={flat[activeIndex] ? id + '-result-' + activeIndex : undefined}
                aria-label={t('globalSearch.placeholder')} placeholder={t('globalSearch.placeholder')}
                value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {
                  composingEndedAt.current = Date.now(); setQuery(event.currentTarget.value); setComposing(false);
                }} />
            </span>
            {query ? <button type="button" className="global-search-clear" onClick={() => { setQuery(''); input.current?.focus(); }} aria-label={t('globalSearch.clear')}><X size={16} /></button> : null}
          </div>
          {loading ? <Loader2 size={17} className="animate-spin" aria-label={t('globalSearch.searching')} /> : null}
          <ProjectScopePicker projects={projects} value={projectName} onChange={setProjectName} />
        </div>
        <div className="global-search-filters">
          <div role="tablist" aria-label={t('globalSearch.categories')}>
            {(['all', ...SEARCH_KINDS] as const).map(name => <button key={name} type="button" role="tab"
              aria-label={label(name)} aria-selected={kind === name} onClick={() => setKind(name)}>{label(name)}
              {trimmed && results && (kind === 'all' || name === kind) ? <span className="global-search-tab-count" aria-hidden>
                {name === 'all' ? results.counts.chats + results.counts.files : results.counts[name]}
              </span> : null}
            </button>)}
          </div>
        </div>
        <div ref={list} className="global-search-body" id={id + '-results'} role="listbox" aria-label={t('globalSearch.results')} aria-busy={loading || (!trimmed && recentFiles.loading)}>
          {trimmed && results?.partial.length ? <div className="global-search-partial" role="status">{t('globalSearch.partial')}</div> : null}
          {!trimmed ? <>
            {history.length ? <div className="global-search-history">
              <div className="global-search-section-title"><span>{t('globalSearch.history')}</span>
                <button type="button" aria-label={t('globalSearch.clearHistory')} onClick={() => {
                  setHistory([]); try { localStorage.removeItem(HISTORY_KEY); } catch { /* Optional storage. */ }
                }}><Trash2 size={14} /></button></div>
              <div className="global-search-history-items">{history.map(item => <button key={item} type="button" onClick={() => setQuery(item)}><Clock3 size={13} />{item}</button>)}</div>
            </div> : null}
            {recentGroups.map(group => <div key={group.kind} className="global-search-group">
              <div className="global-search-section-title">{t(group.kind === 'files' ? 'globalSearch.recentFiles' : 'globalSearch.recent')}</div>
              {group.items.length ? group.items.map(result => row(result, resultIndex++))
                : <div className="global-search-recent-empty" role="status">
                  {group.kind === 'files' && recentFiles.loading ? <Loader2 size={15} className="animate-spin" aria-label={t('globalSearch.searching')} />
                    : t(group.kind === 'files' ? 'globalSearch.noRecentFiles' : 'globalSearch.noRecentChats')}
                </div>}
            </div>)}
          </> : error ? <div className="global-search-empty" role="alert"><p>{t('globalSearch.error')}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t('globalSearch.retry')}</button></div>
            : !results && loading ? <div className="global-search-empty"><Loader2 size={25} className="animate-spin" /><p>{t('globalSearch.searching')}</p></div>
              : !total && !loading ? <div className="global-search-empty"><Search size={28} strokeWidth={1.2} /><p>{t('globalSearch.noResults', { query: trimmed })}</p><span>{t('globalSearch.tryAnother')}</span></div>
                : visibleGroups.map(group => group.items.length ? <div key={group.kind} className="global-search-group">
                  <div className="global-search-section-title"><span>{label(group.kind)} <span className="global-search-count">{results?.counts[group.kind]}</span>
                    {results?.pending?.[group.kind] ? <Loader2 size={12} className="animate-spin" aria-label={t('globalSearch.searching')} /> : null}</span>
                    {kind === 'all' && (results?.counts[group.kind] || 0) > group.items.length ? <button type="button" onClick={() => setKind(group.kind)}>{t('globalSearch.viewAll')}<ChevronRight size={12} strokeWidth={1.5} aria-hidden /></button> : null}</div>
                  {group.items.map(result => row(result, resultIndex++))}
                </div> : null)}
          {kind !== 'all' && results?.hasMore[kind] ? <button type="button" className="global-search-load-more" disabled={loading}
            onClick={() => setOffset(results.groups[kind].length)}>{t('globalSearch.loadMore')}</button> : null}
        </div>
      </section>
    </div>, document.body,
  );
}
