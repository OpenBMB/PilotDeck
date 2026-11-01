/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { forgetRecentFiles, isRecentFilesStorageKey, readRecentFiles, recordRecentFile, workspaceRecentFile, type RecentFile, type RecentFileIdentity } from './recentFiles';

export const SEARCH_KINDS = ['chats', 'files'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
export type GlobalSearchResult = {
  id: string;
  kind: SearchKind;
  project: Project;
  title: string;
  sessionId?: string;
  sessionTitle?: string;
  snippet?: string;
  matchType?: 'title' | 'content' | 'path';
  matchCount?: number;
  path?: string;
  line?: number;
  column?: number;
  entryId?: string;
  sequence?: number;
  turnId?: string;
  role?: 'user' | 'assistant';
  timestamp?: string | number;
};
export type GlobalSearchTarget = GlobalSearchResult & { query: string; requestId: string };
type SearchContext = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  target: GlobalSearchTarget | null;
  reveal: (result: GlobalSearchResult, query: string) => void;
  recentFiles: RecentFile[];
  recordFileVisit: (project: Project, path: string) => void;
  forgetFiles: (files: RecentFileIdentity[]) => void;
};
const Context = createContext<SearchContext | null>(null);

export function GlobalSearchProvider({ children, userKey = 'local' }: { children: ReactNode; userKey?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<GlobalSearchTarget | null>(null);
  const [recent, setRecent] = useState(() => ({ userKey, files: readRecentFiles(userKey) }));
  const activeUser = useRef(userKey);
  activeUser.current = userKey;
  useEffect(() => {
    setRecent({ userKey, files: readRecentFiles(userKey) });
    const sync = (event: StorageEvent) => {
      if (isRecentFilesStorageKey(event.key, userKey)) setRecent({ userKey, files: readRecentFiles(userKey) });
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [userKey]);
  const forgetFiles = useCallback((files: RecentFileIdentity[]) => {
    setRecent({ userKey, files: forgetRecentFiles(userKey, files) });
  }, [userKey]);
  const recordFileVisit = useCallback((project: Project, path: string) => {
    const file = workspaceRecentFile(project, path);
    if (!file) return;
    void api.fileMetadata(project.name, file.path).then(response => {
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          const files = forgetRecentFiles(userKey, [file]);
          if (activeUser.current === userKey) setRecent({ userKey, files });
        }
        return;
      }
      const files = recordRecentFile(userKey, file);
      if (activeUser.current === userKey) setRecent({ userKey, files });
    }).catch(() => { /* A transient file-server error must not become a visit. */ });
  }, [userKey]);
  const open = useCallback(() => {
    setIsOpen(true);
    const input = document.querySelector<HTMLInputElement>('[data-global-search] input');
    input?.focus(); input?.select();
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const reveal = useCallback((result: GlobalSearchResult, query: string) => {
    setTarget({ ...result, query, requestId: crypto.randomUUID() });
    setIsOpen(false);
  }, []);
  const recentFiles = recent.userKey === userKey ? recent.files : [];
  const value = useMemo(() => ({ isOpen, open, close, target, reveal, recentFiles, recordFileVisit, forgetFiles }),
    [isOpen, open, close, target, reveal, recentFiles, recordFileVisit, forgetFiles]);
  return <Context.Provider value={value}>
    <FindShortcutProvider activeScope="chat" onGlobalFind={open}>{children}</FindShortcutProvider>
  </Context.Provider>;
}

export const useGlobalSearch = () => useContext(Context);
