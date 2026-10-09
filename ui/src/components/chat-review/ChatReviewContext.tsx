import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authenticatedFetch } from '../../utils/api';
import type { Project, ProjectSession } from '../../types/app';
import type { CheckpointSummary, RestorePlan, RestoreOperation, CheckpointRequest } from '../../../../src/session/checkpoints/types';

export type { CheckpointSummary, RestorePlan, RestoreOperation };
export type ReviewTab = 'changes' | 'checkpoints' | 'git';
export type ReviewOpenRequest = { tab: ReviewTab; sequence: number };
export type OperationSummary = Pick<RestoreOperation, 'id' | 'status' | 'applied' | 'skipped' | 'createdAt' | 'mode' | 'checkpointId' | 'undoOf'>;
type ReviewData = { checkpoints: CheckpointSummary[]; sessionChanges: CheckpointSummary['changes']; sessionRevision?: string; operations: OperationSummary[]; busy: boolean };
export type GitEntry = { path: string; originalPath?: string; indexStatus: string; worktreeStatus: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean };
export type GitStatus = { branch?: string; hasCommits?: boolean; isRepository?: boolean; code?: string; repositoryRoot?: string; indexTree?: string; entries?: GitEntry[]; error?: string };
type ContextValue = {
  project: Project | null; sessionId: string | null; running: boolean; readOnly: boolean;
  panelOpen: boolean; tab: ReviewTab; checkpointId: string | null; filePath: string | null;
  data: ReviewData; git: GitStatus | null; error: string | null; loading: boolean;
  scope: 'turn' | 'session'; setScope: (scope: 'turn' | 'session') => void;
  bind: (project: Project | null, sessionId: string | null, running: boolean, readOnly: boolean) => void;
  open: (tab?: ReviewTab, checkpointId?: string, filePath?: string) => void;
  close: () => void; refresh: () => Promise<void>; refreshGit: () => Promise<void>;
  request: <T>(action: CheckpointRequest['action'], options?: Partial<CheckpointRequest>) => Promise<T>;
  preview: (id: string, scope?: CheckpointRequest['scope'], mode?: RestorePlan['mode']) => Promise<void>;
  undo: (id: string) => Promise<void>; plan: RestorePlan | null; setPlan: (plan: RestorePlan | null) => void;
  restore: (paths: string[]) => Promise<void>; restoring: boolean;
};
const Context = createContext<ContextValue | null>(null);
const EMPTY: ReviewData = { checkpoints: [], sessionChanges: [], operations: [], busy: false };
export const REVIEW_RESTORED_EVENT = 'pilotdeck:files-restored';

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || '请求失败，请重试。');
  return body as T;
}

export function ChatReviewProvider({ project: initialProject, session, openGit = false, openRequest, onOpen, children }: {
  project: Project | null; session: ProjectSession | null; openGit?: boolean; openRequest?: ReviewOpenRequest; onOpen: () => void; children: ReactNode;
}) {
  const [binding, setBinding] = useState({ project: initialProject, sessionId: session?.id ?? null, running: false, readOnly: false });
  const { project, sessionId, running, readOnly } = binding;
  const [panelOpen, setPanelOpen] = useState(false), [tab, setTab] = useState<ReviewTab>('changes');
  const [checkpointId, setCheckpointId] = useState<string | null>(null), [filePath, setFilePath] = useState<string | null>(null);
  const [scope, setScope] = useState<'turn' | 'session'>('turn');
  const [data, setData] = useState<ReviewData>(EMPTY), [git, setGit] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null), [restoring, setRestoring] = useState(false);
  const generation = useRef(0), gitGeneration = useRef(0);
  const handledOpenRequest = useRef<ReviewOpenRequest>();
  const bindingKey = `${project?.fullPath || project?.path || project?.name || ''}\0${sessionId || ''}`;
  const activeKey = useRef(bindingKey);
  activeKey.current = bindingKey;
  const bind = useCallback((nextProject: Project | null, id: string | null, active: boolean, immutable: boolean) => {
    setBinding(previous => previous.project === nextProject && previous.sessionId === id && previous.running === active && previous.readOnly === immutable ? previous : { project: nextProject, sessionId: id, running: active, readOnly: immutable });
  }, []);
  const request = useCallback(async <T,>(action: CheckpointRequest['action'], options: Partial<CheckpointRequest> = {}): Promise<T> => {
    if (!project || !sessionId) throw new Error('请选择一个项目对话。');
    return readJson<T>(await authenticatedFetch('/api/checkpoints', { method: 'POST', suppressServerErrorToast: true,
      body: JSON.stringify({ ...options, action, project: project.name, sessionId }) }));
  }, [project, sessionId]);
  const refresh = useCallback(async () => {
    if (!project || !sessionId) return;
    const sequence = ++generation.current, key = bindingKey;
    setLoading(true);
    try { const result = await request<ReviewData>('list'); if (sequence === generation.current && key === activeKey.current) { setData(result); setError(null); } }
    catch (failure) { if (sequence === generation.current && key === activeKey.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (sequence === generation.current && key === activeKey.current) setLoading(false); }
  }, [project, sessionId, bindingKey, request]);
  const refreshGit = useCallback(async () => {
    if (!project) return;
    const sequence = ++gitGeneration.current, key = bindingKey;
    try {
      const response = await authenticatedFetch(`/api/git/status?project=${encodeURIComponent(project.name)}`, { suppressServerErrorToast: true });
      const status = await response.json() as GitStatus;
      if (sequence === gitGeneration.current && key === activeKey.current) setGit(status);
    } catch { if (sequence === gitGeneration.current && key === activeKey.current) setGit({ error: 'Git 状态读取失败，请刷新重试。' }); }
  }, [project, bindingKey]);
  const open = useCallback((nextTab: ReviewTab = 'changes', id?: string, relative?: string) => {
    onOpen(); setTab(nextTab); setPanelOpen(true);
    if (id) { setCheckpointId(id); setScope('turn'); }
    if (relative) setFilePath(relative); else if (id) setFilePath(null);
  }, [onOpen]);
  useEffect(() => { if (openGit) open('git'); }, [openGit, open]);
  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest) return;
    handledOpenRequest.current = openRequest;
    open(openRequest.tab);
  }, [openRequest, open]);
  useEffect(() => {
    generation.current++; gitGeneration.current++; setData(EMPTY); setGit(null); setError(null); setPlan(null); setCheckpointId(null); setFilePath(null); setScope('turn');
  }, [bindingKey]);
  useEffect(() => { void refresh(); void refreshGit(); }, [refresh, refreshGit, running]);
  useEffect(() => {
    if (!running && !panelOpen) return undefined;
    const timer = window.setInterval(() => { void refresh(); if (panelOpen && tab === 'git') void refreshGit(); }, 5000);
    return () => window.clearInterval(timer);
  }, [running, panelOpen, tab, refresh, refreshGit]);
  const preview = useCallback(async (id: string, restoreScope: CheckpointRequest['scope'] = 'turn', mode: RestorePlan['mode'] = 'files') => {
    const key = bindingKey;
    setError(null);
    try { const next = await request<RestorePlan>('preview', { checkpointId: id, scope: restoreScope, mode }); if (key === activeKey.current) setPlan(next); }
    catch (failure) { if (key === activeKey.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [request, bindingKey]);
  const undo = useCallback(async (id: string) => {
    const key = bindingKey;
    setError(null);
    try { const next = await request<RestorePlan>('undo', { operationId: id }); if (key === activeKey.current) setPlan(next); }
    catch (failure) { if (key === activeKey.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [request, bindingKey]);
  const restore = useCallback(async (paths: string[]) => {
    if (!plan || restoring) return;
    setRestoring(true); setError(null);
    try {
      await request<RestoreOperation>('restore', { planId: plan.id, paths });
      setPlan(null); await refresh(); await refreshGit();
      window.dispatchEvent(new CustomEvent(REVIEW_RESTORED_EVENT, { detail: { sessionId } }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); await refresh(); }
    finally { setRestoring(false); }
  }, [plan, restoring, request, refresh, refreshGit, sessionId]);
  const value = useMemo<ContextValue>(() => ({ project, sessionId, running, readOnly, panelOpen, tab, checkpointId, filePath, data, git, error, loading, scope, setScope,
    bind, open, close: () => { setPanelOpen(false); setPlan(null); }, refresh, refreshGit, request, preview, undo, plan, setPlan, restore, restoring }),
  [project, sessionId, running, readOnly, panelOpen, tab, checkpointId, filePath, data, git, error, loading, scope, bind, open, refresh, refreshGit, request, preview, undo, plan, restore, restoring]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChatReview() { return useContext(Context); }

export function activeRestoration(operations: OperationSummary[], checkpointId?: string) {
  const restoration = operations.filter(item => !item.undoOf && item.checkpointId === checkpointId && item.status === 'complete').at(-1);
  return restoration && !operations.some(item => item.undoOf === restoration.id && item.status === 'complete') ? restoration : null;
}
