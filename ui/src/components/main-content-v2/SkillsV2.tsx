import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Download,
  Folder,
  FolderInput,
  FolderSearch,
  Globe,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';
import { useTheme } from '../../contexts/ThemeContext';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import { cn } from '../../lib/utils.js';

type SkillsV2Props = {
  selectedProject: Project | null;
  projects: Project[];
};

type Skill = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  skillFile: string;
  skillDir: string;
  scope: 'user' | 'project';
  mtime: number | null;
};

type SkillsListResponse = {
  user: Skill[];
  project: Skill[];
  projectPath: string | null;
  isGeneralCwd: boolean;
};

type SearchResult = { slug: string; name: string; score: number | null };

type InstallResponse = {
  ok: boolean;
  slug: string;
  scope: 'user' | 'project';
  installPath: string;
  installed: boolean;
  skill: Skill | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  needsForce: boolean;
};

type ToastState = { kind: 'success' | 'error' | 'info'; text: string } | null;

// --- Evo (Skill evolution) -------------------------------------------------

type EvoPolicyMode = 'manual' | 'auto-low-risk' | 'auto-all';
type EvoRiskLevel = 'low' | 'medium' | 'high';
type EvoRunStatus = 'proposed' | 'ready' | 'applied' | 'discarded' | 'failed';

type EvoRun = {
  runId: string;
  status: EvoRunStatus;
  policy: EvoPolicyMode;
  autoApplied: boolean;
  reason: string;
  candidate: {
    baseContent: string;
    candidateContent: string;
    hypothesis: string;
    riskLevel: EvoRiskLevel;
    riskNotes: string[];
  };
  report: { recommendation: 'apply' | 'review' | 'reject' };
  error?: { code: string; message: string };
};

type EvoStartResponse = { run: EvoRun | null; error?: { code: string; message: string } };
type EvoStatusResponse = { policy: EvoPolicyMode; runs: unknown[] };
type EvoReportResponse = { markdown: string; error?: { code: string; message: string } };
type EvoApplyResponse = { run: EvoRun | null; error?: { code: string; message: string } };

// ---------------------------------------------------------------------------

function projectCwd(p: Project | null): string | null {
  if (!p) return null;
  return p.fullPath || p.path || null;
}

function isGeneralProject(p: Project | null): boolean {
  if (!p) return false;
  return p.name === 'general' || p.displayName === 'general';
}

async function api<T>(url: string, body: unknown): Promise<T> {
  const r = await authenticatedFetch(url, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message || `Request failed (${r.status})`;
    throw new Error(message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------

export default function SkillsV2({ selectedProject, projects }: SkillsV2Props) {
  const { t } = useTranslation();
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };

  const cwd = projectCwd(selectedProject);
  const localGeneralCwd = isGeneralProject(selectedProject);

  const [skills, setSkills] = useState<SkillsListResponse | null>(null);
  const [serverGeneralCwdPath, setServerGeneralCwdPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<'user' | 'project' | null>(null);
  const [editorContent, setEditorContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showEvo, setShowEvo] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const serverGeneralCwd = Boolean(cwd && serverGeneralCwdPath === cwd);
  const generalCwd = localGeneralCwd || serverGeneralCwd;
  const effectiveProjectPath = generalCwd ? null : cwd;

  const flashToast = useCallback((toastValue: ToastState, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SkillsListResponse>('/api/skills/list', {
        projectPath: effectiveProjectPath,
      });
      setSkills(data);
      setServerGeneralCwdPath((prev) => {
        if (!cwd) return null;
        if (data.isGeneralCwd) return cwd;
        if (effectiveProjectPath === null && (localGeneralCwd || prev === cwd)) return prev;
        return prev === cwd ? null : prev;
      });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [cwd, effectiveProjectPath, flashToast, localGeneralCwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (generalCwd && activeScope === 'project') {
      setActiveScope(null);
      setActiveSlug(null);
    }
  }, [activeScope, generalCwd]);

  const activeSkill = useMemo(() => {
    if (!skills || !activeSlug) return null;
    const list = activeScope === 'project' ? skills.project : skills.user;
    return list.find((s) => s.slug === activeSlug) ?? null;
  }, [skills, activeSlug, activeScope]);

  // Load SKILL.md when active skill changes
  useEffect(() => {
    if (!activeSkill) {
      setEditorContent('');
      setOriginalContent('');
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    api<{ content: string }>('/api/skills/read', {
      skillPath: activeSkill.skillDir,
      projectPath: effectiveProjectPath,
    })
      .then((data) => {
        if (cancelled) return;
        setEditorContent(data.content);
        setOriginalContent(data.content);
      })
      .catch((e) => {
        if (cancelled) return;
        flashToast({ kind: 'error', text: (e as Error).message });
        setEditorContent('');
        setOriginalContent('');
      })
      .finally(() => {
        if (!cancelled) setEditorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSkill, effectiveProjectPath, flashToast]);

  const isDirty = editorContent !== originalContent;

  const handleSave = useCallback(async () => {
    if (!activeSkill) return;
    setSaving(true);
    try {
      const result = await api<{ ok: boolean; skill: Skill }>('/api/skills/write', {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
        content: editorContent,
      });
      setOriginalContent(editorContent);
      // Patch the skill in-place so list metadata (name/desc) refreshes.
      setSkills((prev) => {
        if (!prev) return prev;
        const updateIn = (list: Skill[]) =>
          list.map((s) => (s.slug === activeSkill.slug && s.scope === activeSkill.scope
            ? { ...s, ...result.skill, scope: activeSkill.scope }
            : s));
        return {
          ...prev,
          user: updateIn(prev.user),
          project: updateIn(prev.project),
        };
      });
      flashToast({ kind: 'success', text: t('skillsTab.savedSuccess', { defaultValue: 'Saved' }) });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [activeSkill, editorContent, effectiveProjectPath, flashToast, t]);

  const handleDelete = useCallback(async () => {
    if (!activeSkill) return;
    if (!window.confirm(t('skillsTab.confirmDelete', { defaultValue: 'Delete this skill? This will remove the entire folder.', name: activeSkill.name }) as string)) {
      return;
    }
    try {
      await api('/api/skills/delete', {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
      });
      setActiveSlug(null);
      setActiveScope(null);
      await refresh();
      flashToast({ kind: 'success', text: t('skillsTab.deletedSuccess', { defaultValue: 'Deleted' }) });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [activeSkill, effectiveProjectPath, refresh, flashToast, t]);

  const handleSelect = useCallback((skill: Skill) => {
    if (isDirty) {
      if (!window.confirm(t('skillsTab.discardUnsaved', { defaultValue: 'Discard unsaved changes?' }) as string)) {
        return;
      }
    }
    setActiveSlug(skill.slug);
    setActiveScope(skill.scope);
  }, [isDirty, t]);

  // ------------------------------------------------------------------------

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('skillsTab.pickProject', { defaultValue: 'Open a project to manage its skills.' })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950">
      <Header
        cwd={cwd}
        generalCwd={generalCwd}
        loading={loading}
        onRefresh={refresh}
        onNew={() => setShowNew(true)}
        t={t}
      />

      <div className="flex min-h-0 flex-1">
        <SkillsList
          skills={skills}
          loading={loading}
          activeSlug={activeSlug}
          activeScope={activeScope}
          generalCwd={generalCwd}
          onSelect={handleSelect}
          selectedSkill={activeSkill}
          effectiveProjectPath={effectiveProjectPath}
          projects={projects}
          refresh={refresh}
          flashToast={flashToast}
          setActiveSlug={setActiveSlug}
          setActiveScope={setActiveScope}
          t={t}
        />
        <div className="flex min-h-0 flex-1 flex-col border-l border-neutral-200 dark:border-neutral-800">
          {activeSkill ? (
            <SkillDetail
              skill={activeSkill}
              content={editorContent}
              onChange={setEditorContent}
              isDirty={isDirty}
              loading={editorLoading}
              saving={saving}
              isDarkMode={isDarkMode}
              onSave={handleSave}
              onDelete={handleDelete}
              onRevert={() => setEditorContent(originalContent)}
              onEvolve={() => setShowEvo(true)}
              t={t}
            />
          ) : (
            <EmptyState t={t} />
          )}
        </div>
      </div>

      {showNew ? (
        <NewSkillModal
          onClose={() => setShowNew(false)}
          onCreated={async (created) => {
            await refresh();
            setActiveSlug(created.slug);
            setActiveScope(created.scope);
            setShowNew(false);
            flashToast({ kind: 'success', text: t('skillsTab.installedSuccess', { defaultValue: 'Installed', name: created.name }) });
          }}
          projectAvailable={Boolean(effectiveProjectPath)}
          projectPath={effectiveProjectPath}
          t={t}
        />
      ) : null}

      {showEvo && activeSkill ? (
        <EvoModal
          skill={activeSkill}
          projectPath={effectiveProjectPath}
          onClose={() => setShowEvo(false)}
          onChanged={async () => {
            await refresh();
          }}
          flashToast={flashToast}
          t={t}
        />
      ) : null}

      {toast ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg',
            toast.kind === 'success' && 'bg-emerald-600 text-white',
            toast.kind === 'error' && 'bg-red-600 text-white',
            toast.kind === 'info' && 'bg-neutral-800 text-white',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  cwd,
  generalCwd,
  loading,
  onRefresh,
  onNew,
  t,
}: {
  cwd: string | null;
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
  onNew: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-6 dark:border-neutral-800">
      <div className="flex min-w-0 items-center gap-2 truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.75} />
        {generalCwd ? (
          <span>{t('skillsTab.generalChat', { defaultValue: 'General chat — user-scope skills only' })}</span>
        ) : (
          <span className="truncate">{cwd}</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('skillsTab.refresh', { defaultValue: 'Refresh' }) as string}
          aria-label={t('skillsTab.refresh', { defaultValue: 'Refresh' }) as string}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{t('skillsTab.newSkill', { defaultValue: 'New' })}</span>
        </button>
      </div>
    </div>
  );
}

type MoveTarget = { scope: 'user'; projectPath: null } | { scope: 'project'; projectPath: string };

function SkillsList({
  skills,
  loading,
  activeSlug,
  activeScope,
  generalCwd,
  onSelect,
  selectedSkill,
  effectiveProjectPath,
  projects,
  refresh,
  flashToast,
  setActiveSlug,
  setActiveScope,
  t,
}: {
  skills: SkillsListResponse | null;
  loading: boolean;
  activeSlug: string | null;
  activeScope: 'user' | 'project' | null;
  generalCwd: boolean;
  onSelect: (s: Skill) => void;
  selectedSkill: Skill | null;
  effectiveProjectPath: string | null;
  projects: Project[];
  refresh: () => Promise<void>;
  flashToast: (t: ToastState, ms?: number) => void;
  setActiveSlug: (slug: string | null) => void;
  setActiveScope: (scope: 'user' | 'project' | null) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handleDeleteSkill = useCallback(async (skill: Skill) => {
    if (!window.confirm(t('skillsTab.confirmUninstall', { defaultValue: 'Uninstall "{{name}}"? This will remove the entire skill folder.', name: skill.name }) as string)) {
      return;
    }
    try {
      await api('/api/skills/delete', {
        skillPath: skill.skillDir,
        projectPath: effectiveProjectPath,
      });
      if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
        setActiveSlug(null);
        setActiveScope(null);
      }
      await refresh();
      flashToast({ kind: 'success', text: t('skillsTab.uninstallSuccess', { defaultValue: 'Uninstalled "{{name}}"', name: skill.name }) as string });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveSlug, setActiveScope, t]);

  const handleMoveSkill = useCallback(async (skill: Skill, target: MoveTarget) => {
    try {
      await api('/api/skills/import', {
        sourcePath: skill.skillDir,
        slug: skill.slug,
        scope: target.scope,
        projectPath: target.projectPath,
        mode: 'copy',
        force: false,
      });
      await api('/api/skills/delete', {
        skillPath: skill.skillDir,
        projectPath: effectiveProjectPath,
      });
      if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
        setActiveScope(target.scope);
      }
      await refresh();
      const label = target.scope === 'user' ? 'User' : target.projectPath.split('/').pop() || 'Project';
      flashToast({
        kind: 'success',
        text: t('skillsTab.moveSuccess', {
          defaultValue: 'Moved "{{name}}" to {{scope}}',
          name: skill.name,
          scope: label,
        }) as string,
      });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveScope, t]);

  const moveTargets = useMemo((): { label: string; target: MoveTarget }[] => {
    const targets: { label: string; target: MoveTarget }[] = [];
    targets.push({ label: 'User (global)', target: { scope: 'user', projectPath: null } });
    for (const project of projects) {
      const path = project.fullPath || project.path || null;
      if (!path) continue;
      if (project.name === 'general' || project.displayName === 'general') continue;
      targets.push({
        label: project.displayName || project.name,
        target: { scope: 'project', projectPath: path },
      });
    }
    return targets;
  }, [projects]);

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800">
      <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]">
        {loading && !skills ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <>
            {!generalCwd && skills?.project && skills.project.length > 0 ? (
              <ListSection
                title={t('skillsTab.projectScope', { defaultValue: 'Project Skills' })}
                items={skills.project}
                activeSlug={activeScope === 'project' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills?.user && skills.user.length > 0 ? (
              <ListSection
                title={t('skillsTab.userScope', { defaultValue: 'User Skills' })}
                items={skills.user}
                activeSlug={activeScope === 'user' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills && skills.user.length === 0 && (generalCwd || skills.project.length === 0) ? (
              <div className="px-4 py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
                {t('skillsTab.empty', { defaultValue: 'No skills yet. Click "New" to install or create one.' })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

type ContextMenuState = { skill: Skill; x: number; y: number } | null;

function ListSection({
  title,
  items,
  activeSlug,
  onSelect,
  onDelete,
  onMove,
  moveTargets,
  currentProjectPath,
  t,
}: {
  title: string;
  items: Skill[];
  activeSlug: string | null;
  onSelect: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  onMove: (s: Skill, target: MoveTarget) => void;
  moveTargets: { label: string; target: MoveTarget }[];
  currentProjectPath: string | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleClose = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
        return;
      }
      if (e instanceof MouseEvent && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClose);
    document.addEventListener('keydown', handleClose);
    return () => {
      document.removeEventListener('mousedown', handleClose);
      document.removeEventListener('keydown', handleClose);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, skill: Skill) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ skill, x: e.clientX, y: e.clientY });
    setShowMoveSubmenu(false);
  }, []);

  const filteredMoveTargets = useMemo(() => {
    if (!ctxMenu) return [];
    const skill = ctxMenu.skill;
    return moveTargets.filter((mt) => {
      if (skill.scope === 'user' && mt.target.scope === 'user') return false;
      if (skill.scope === 'project' && mt.target.scope === 'project' && mt.target.projectPath === currentProjectPath) return false;
      return true;
    });
  }, [ctxMenu, moveTargets, currentProjectPath]);

  return (
    <div className="mb-2">
      <div className="px-4 py-1 text-xxs uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {title} <span className="text-neutral-300 dark:text-neutral-600">· {items.length}</span>
      </div>
      <ul className="space-y-0.5 px-2">
        {items.map((s) => {
          const isActive = activeSlug === s.slug;
          return (
            <li key={`${s.scope}:${s.slug}`} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(s)}
                onContextMenu={(e) => handleContextMenu(e, s)}
                className={cn(
                  'block w-full truncate rounded-md px-2 py-1.5 pr-8 text-left text-[13px] transition-colors',
                  isActive
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900/60',
                )}
                title={s.description || s.name}
              >
                <div className="flex items-center gap-1.5 truncate font-medium">
                  <span className="truncate">{s.name}</span>
                  {s.version ? (
                    <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      v{s.version}
                    </span>
                  ) : null}
                </div>
                {s.description ? (
                  <div className="mt-0.5 line-clamp-1 text-xxs text-neutral-500 dark:text-neutral-400">
                    {s.description}
                  </div>
                ) : null}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s);
                }}
                className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600 group-hover:inline-flex dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                title={t('skillsTab.delete', { defaultValue: 'Delete' }) as string}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </li>
          );
        })}
      </ul>

      {ctxMenu ? (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[180px] rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {filteredMoveTargets.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                onMouseEnter={() => setShowMoveSubmenu(true)}
                onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span className="flex items-center gap-2">
                  <ArrowRightLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>{t('skillsTab.moveTo', { defaultValue: 'Move to…' })}</span>
                </span>
                <span className="text-neutral-400">›</span>
              </button>
              {showMoveSubmenu ? (
                <div
                  className="absolute left-full top-0 z-[101] ml-1 min-w-[160px] max-h-[240px] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {filteredMoveTargets.map((mt) => (
                    <button
                      key={mt.target.scope + ':' + (mt.target.projectPath || 'user')}
                      type="button"
                      onClick={() => {
                        const skill = ctxMenu.skill;
                        setCtxMenu(null);
                        setShowMoveSubmenu(false);
                        onMove(skill, mt.target);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      {mt.target.scope === 'user' ? (
                        <Globe className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" strokeWidth={1.75} />
                      )}
                      <span className="truncate">{mt.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const skill = ctxMenu.skill;
              setCtxMenu(null);
              setShowMoveSubmenu(false);
              onDelete(skill);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.delete', { defaultValue: 'Delete' })}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
      <Sparkles className="h-8 w-8 text-neutral-300 dark:text-neutral-700" strokeWidth={1.5} />
      <div>{t('skillsTab.selectHint', { defaultValue: 'Pick a skill on the left to view or edit its SKILL.md.' })}</div>
    </div>
  );
}

function SkillDetail({
  skill,
  content,
  onChange,
  isDirty,
  loading,
  saving,
  isDarkMode,
  onSave,
  onDelete,
  onRevert,
  onEvolve,
  t,
}: {
  skill: Skill;
  content: string;
  onChange: (v: string) => void;
  isDirty: boolean;
  loading: boolean;
  saving: boolean;
  isDarkMode: boolean;
  onSave: () => void;
  onDelete: () => void;
  onRevert: () => void;
  onEvolve: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {skill.name}
          </h2>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
              skill.scope === 'project'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
            )}
          >
            {skill.scope}
          </span>
          {skill.version ? (
            <span className="text-xxs text-neutral-500 dark:text-neutral-400">v{skill.version}</span>
          ) : null}
        </div>
        {skill.description ? (
          <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{skill.description}</p>
        ) : null}
        <div className="mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
          {skill.skillDir}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <CodeMirror
            value={content}
            onChange={onChange}
            extensions={[markdown(), EditorView.lineWrapping]}
            theme={isDarkMode ? zincDarkTheme : zincLightTheme}
            height="100%"
            style={{ height: '100%', fontSize: '13px' }}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              indentOnInput: true,
              autocompletion: false,
              searchKeymap: true,
            }}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 px-6 py-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{t('skillsTab.delete', { defaultValue: 'Delete' })}</span>
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onEvolve}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 px-2.5 text-[12px] font-medium text-amber-700 transition hover:bg-amber-50 dark:border-amber-700/60 dark:text-amber-300 dark:hover:bg-amber-950/40"
            title={t('skillsTab.evolveHint', { defaultValue: 'Generate a project-adapted candidate for this skill' }) as string}
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.evolve', { defaultValue: 'Evolve' })}</span>
          </button>
          {isDirty ? (
            <button
              type="button"
              onClick={onRevert}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t('skillsTab.revert', { defaultValue: 'Revert' })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={!isDirty || saving}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Save className="h-3.5 w-3.5" strokeWidth={1.75} />}
            <span>{saving ? t('skillsTab.saving', { defaultValue: 'Saving…' }) : t('skillsTab.save', { defaultValue: 'Save' })}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evo modal — generate a project-adapted candidate, review diff + report,
// then Apply / Discard. Mirrors the gateway evo_* RPCs via /api/evo/*.
// ---------------------------------------------------------------------------

type DiffRow = { type: 'context' | 'added' | 'removed'; text: string };

/**
 * Minimal line diff: shared prefix + shared suffix as context, the differing
 * middle of base as removed and of candidate as added. Good enough for the
 * additive / appended candidates Evo produces.
 */
function simpleLineDiff(base: string, candidate: string): DiffRow[] {
  const a = base.split('\n');
  const b = candidate.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) rows.push({ type: 'context', text: a[i] });
  for (let i = start; i <= endA; i += 1) rows.push({ type: 'removed', text: a[i] });
  for (let i = start; i <= endB; i += 1) rows.push({ type: 'added', text: b[i] });
  for (let i = endA + 1; i < a.length; i += 1) rows.push({ type: 'context', text: a[i] });
  return rows;
}

const EVO_POLICIES: { value: EvoPolicyMode; labelKey: string; fallback: string }[] = [
  { value: 'manual', labelKey: 'skillsTab.evoPolicyManual', fallback: 'Manual (review every change)' },
  { value: 'auto-low-risk', labelKey: 'skillsTab.evoPolicyAutoLow', fallback: 'Auto (low-risk only)' },
  { value: 'auto-all', labelKey: 'skillsTab.evoPolicyAutoAll', fallback: 'Auto (low + medium risk)' },
];

function EvoModal({
  skill,
  projectPath,
  onClose,
  onChanged,
  flashToast,
  t,
}: {
  skill: Skill;
  projectPath: string | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  flashToast: (toast: ToastState, ms?: number) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [policy, setPolicy] = useState<EvoPolicyMode>('manual');
  const [testCommand, setTestCommand] = useState('');
  const [commonPaths, setCommonPaths] = useState('');
  const [codeStyle, setCodeStyle] = useState('');
  const [notes, setNotes] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<EvoRun | null>(null);
  const [reportMd, setReportMd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<EvoStatusResponse>('/api/evo/status', { projectKey: projectPath })
      .then((data) => {
        if (!cancelled && data.policy) setPolicy(data.policy);
      })
      .catch(() => {/* keep default */});
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const runEvolve = useCallback(async () => {
    setRunning(true);
    setRun(null);
    setReportMd('');
    try {
      const projectFacts = {
        testCommand: testCommand.trim() || undefined,
        commonPaths: commonPaths.split(',').map((p) => p.trim()).filter(Boolean),
        codeStyle: codeStyle.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      const res = await api<EvoStartResponse>('/api/evo/start', {
        projectKey: projectPath,
        target: { kind: 'skill', scope: skill.scope, slug: skill.slug },
        policy,
        projectFacts,
        reason: `Adapt skill "${skill.slug}" to the current project.`,
      });
      if (res.error) {
        flashToast({ kind: 'error', text: res.error.message });
        return;
      }
      const started = res.run;
      setRun(started);
      if (started) {
        const rep = await api<EvoReportResponse>('/api/evo/report', { runId: started.runId });
        setReportMd(rep.markdown || '');
        if (started.autoApplied) {
          await onChanged();
          flashToast({ kind: 'success', text: t('skillsTab.evoAutoApplied', { defaultValue: 'Candidate auto-applied per policy' }) });
        }
      }
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }, [testCommand, commonPaths, codeStyle, notes, projectPath, skill.scope, skill.slug, policy, flashToast, onChanged, t]);

  const apply = useCallback(async () => {
    if (!run) return;
    setBusy(true);
    try {
      const res = await api<EvoApplyResponse>('/api/evo/apply', { runId: run.runId });
      if (res.error) {
        flashToast({ kind: 'error', text: res.error.message });
        return;
      }
      setRun(res.run);
      await onChanged();
      flashToast({ kind: 'success', text: t('skillsTab.evoApplied', { defaultValue: 'Candidate applied' }) });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [run, flashToast, onChanged, t]);

  const discard = useCallback(async () => {
    if (!run) return;
    setBusy(true);
    try {
      await api('/api/evo/discard', { runId: run.runId });
      flashToast({ kind: 'info', text: t('skillsTab.evoDiscarded', { defaultValue: 'Candidate discarded' }) });
      onClose();
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [run, flashToast, onClose, t]);

  const noChange = run ? run.candidate.baseContent === run.candidate.candidateContent : false;
  const diff = run && !noChange ? simpleLineDiff(run.candidate.baseContent, run.candidate.candidateContent) : [];
  const canApply = Boolean(run) && run!.status === 'ready' && !noChange;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[600px] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" strokeWidth={1.75} />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t('skillsTab.evolveTitle', { defaultValue: 'Evolve' })}: {skill.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3">
            <label className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {t('skillsTab.evoPolicy', { defaultValue: 'Project policy' })}
            </label>
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value as EvoPolicyMode)}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-[13px] text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            >
              {EVO_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(p.labelKey, { defaultValue: p.fallback })}
                </option>
              ))}
            </select>

            <p className="text-xxs text-neutral-500 dark:text-neutral-400">
              {t('skillsTab.evoFactsHint', { defaultValue: 'Project facts used to adapt this skill (all optional).' })}
            </p>
            <input
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              placeholder={t('skillsTab.evoTestCommand', { defaultValue: 'Test command, e.g. npm run test' }) as string}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-[13px] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <input
              value={commonPaths}
              onChange={(e) => setCommonPaths(e.target.value)}
              placeholder={t('skillsTab.evoPaths', { defaultValue: 'Common paths, comma-separated, e.g. src/, tests/' }) as string}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-[13px] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <input
              value={codeStyle}
              onChange={(e) => setCodeStyle(e.target.value)}
              placeholder={t('skillsTab.evoCodeStyle', { defaultValue: 'Code style notes' }) as string}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-[13px] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('skillsTab.evoNotes', { defaultValue: 'Other notes' }) as string}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-[13px] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />

            <button
              type="button"
              onClick={runEvolve}
              disabled={running}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 text-[13px] font-medium text-white transition hover:bg-amber-500 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <Sparkles className="h-4 w-4" strokeWidth={1.75} />}
              <span>{running ? t('skillsTab.evoRunning', { defaultValue: 'Generating candidate…' }) : t('skillsTab.evoGenerate', { defaultValue: 'Generate candidate' })}</span>
            </button>
          </div>

          {run ? (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xxs">
                <RiskBadge level={run.candidate.riskLevel} t={t} />
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  {t('skillsTab.evoStatus', { defaultValue: 'Status' })}: {run.status}{run.autoApplied ? ' (auto)' : ''}
                </span>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  {t('skillsTab.evoRecommend', { defaultValue: 'Recommendation' })}: {run.report.recommendation}
                </span>
              </div>

              {noChange ? (
                <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xxs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                  {t('skillsTab.evoNoChange', { defaultValue: 'No change proposed — supply project facts above to adapt the skill.' })}
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
                  <div className="flex items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xxs font-medium text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                    <ArrowRightLeft className="h-3 w-3" strokeWidth={1.75} />
                    {t('skillsTab.evoDiff', { defaultValue: 'Proposed diff' })}
                  </div>
                  <div className="max-h-48 overflow-auto font-mono text-[11px] leading-[18px]">
                    {diff.map((row, i) => (
                      <div
                        key={i}
                        className={cn(
                          'whitespace-pre-wrap px-3',
                          row.type === 'added' && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
                          row.type === 'removed' && 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
                          row.type === 'context' && 'text-neutral-500 dark:text-neutral-400',
                        )}
                      >
                        {row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  '}
                        {row.text || ' '}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {reportMd ? (
                <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
                  <summary className="cursor-pointer px-3 py-1.5 text-xxs font-medium text-neutral-600 dark:text-neutral-300">
                    {t('skillsTab.evoReport', { defaultValue: 'Report' })}
                  </summary>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-3 pb-3 text-[11px] text-neutral-600 dark:text-neutral-400">{reportMd}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          {run && run.status !== 'applied' ? (
            <button
              type="button"
              onClick={discard}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              <XCircle className="h-4 w-4" strokeWidth={1.75} />
              {t('skillsTab.evoDiscardBtn', { defaultValue: 'Discard' })}
            </button>
          ) : null}
          {run && run.status === 'applied' ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
              {t('skillsTab.evoAppliedLabel', { defaultValue: 'Applied' })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={apply}
            disabled={!canApply || busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />}
            {t('skillsTab.evoApplyBtn', { defaultValue: 'Apply candidate' })}
          </button>
        </div>
      </div>
    </div>
  );
}

function RiskBadge({ level, t }: { level: EvoRiskLevel; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 uppercase tracking-wider',
        level === 'low' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
        level === 'medium' && 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
        level === 'high' && 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
      )}
    >
      {t('skillsTab.evoRisk', { defaultValue: 'Risk' })}: {level}
    </span>
  );
}

// ---------------------------------------------------------------------------
// New Skill modal — two tabs: Install from ClawHub, Create from scratch
// ---------------------------------------------------------------------------

type NewModalCreated = { slug: string; name: string; scope: 'user' | 'project' };

function NewSkillModal({
  onClose,
  onCreated,
  projectAvailable,
  projectPath,
  t,
}: {
  onClose: () => void;
  onCreated: (created: NewModalCreated) => void;
  projectAvailable: boolean;
  projectPath: string | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [tab, setTab] = useState<'install' | 'import' | 'create'>('install');
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex h-[560px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">{t('skillsTab.newTitle', { defaultValue: 'New Skill' })}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label={t('skillsTab.close', { defaultValue: 'Close' }) as string}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-5 dark:border-neutral-800">
          <ModalTab active={tab === 'install'} onClick={() => setTab('install')} icon={Download}>
            {t('skillsTab.tabInstall', { defaultValue: 'Install from ClawHub' })}
          </ModalTab>
          <ModalTab active={tab === 'import'} onClick={() => setTab('import')} icon={FolderInput}>
            {t('skillsTab.tabImport', { defaultValue: 'Import folder' })}
          </ModalTab>
          <ModalTab active={tab === 'create'} onClick={() => setTab('create')} icon={PencilLine}>
            {t('skillsTab.tabCreate', { defaultValue: 'Write my own' })}
          </ModalTab>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'install' ? (
            <InstallFromClawHub
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onInstalled={onCreated}
              t={t}
            />
          ) : tab === 'import' ? (
            <ImportFromFolder
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onImported={onCreated}
              t={t}
            />
          ) : (
            <CreateFromScratch
              projectAvailable={projectAvailable}
              projectPath={projectPath}
              onCreated={onCreated}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ModalTab({
  active,
  onClick,
  children,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon: typeof Download;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition-colors',
        active
          ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
          : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {children}
    </button>
  );
}

function ScopeSelector({
  scope,
  onChange,
  projectAvailable,
  t,
}: {
  scope: 'user' | 'project';
  onChange: (s: 'user' | 'project') => void;
  projectAvailable: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-neutral-500 dark:text-neutral-400">
        {t('skillsTab.scope', { defaultValue: 'Scope' })}:
      </span>
      <div className="inline-flex overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => onChange('user')}
          className={cn(
            'px-2.5 py-1 transition-colors',
            scope === 'user'
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900',
          )}
        >
          <span className="inline-flex items-center gap-1"><Globe className="h-3 w-3" strokeWidth={1.75} />{t('skillsTab.scopeUser', { defaultValue: 'User' })}</span>
        </button>
        <button
          type="button"
          disabled={!projectAvailable}
          onClick={() => onChange('project')}
          className={cn(
            'px-2.5 py-1 transition-colors',
            scope === 'project'
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-900',
          )}
        >
          {t('skillsTab.scopeProject', { defaultValue: 'Project' })}
        </button>
      </div>
    </div>
  );
}

function InstallFromClawHub({
  projectAvailable,
  projectPath,
  onInstalled,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onInstalled: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<'user' | 'project'>(projectAvailable ? 'project' : 'user');
  const [installing, setInstalling] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [forceForSlug, setForceForSlug] = useState<string | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!projectAvailable && scope === 'project') setScope('user');
  }, [projectAvailable, scope]);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const data = await api<{ results: SearchResult[] }>('/api/skills/clawhub/search', { query });
        setResults(data.results);
      } catch (e) {
        setErrorText((e as Error).message);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  const install = useCallback(async (slug: string, force = false) => {
    setInstalling(slug);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : 'user';
      const r = await api<InstallResponse>('/api/skills/clawhub/install', {
        slug,
        scope: effectiveScope,
        projectPath: effectiveScope === 'project' ? projectPath : null,
        force,
      });
      if (r.installed) {
        onInstalled({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
        return;
      }
      if (r.needsForce) {
        setForceForSlug(slug);
        setErrorText(t('skillsTab.flaggedSuspicious', {
          defaultValue: '"{{slug}}" is flagged as suspicious by VirusTotal. Re-confirm to install with --force.',
          slug,
        }));
        return;
      }
      setErrorText(r.stderr || r.stdout || `Install failed (exit ${r.exitCode})`);
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setInstalling(null);
    }
  }, [projectAvailable, scope, projectPath, onInstalled, t]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
        <div className="relative flex flex-1 items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-neutral-400" strokeWidth={1.75} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('skillsTab.searchPlaceholder', { defaultValue: 'Search clawhub.com…' }) as string}
            className="h-8 w-full rounded-md border border-neutral-200 bg-white pl-8 pr-2 text-[13px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
          />
          {searching ? (
            <Loader2 className="absolute right-2.5 h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
          ) : null}
        </div>
        <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
      </div>

      {errorText ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {errorText}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 && !searching ? (
          <div className="flex h-full items-center justify-center text-xxs text-neutral-500 dark:text-neutral-400">
            {query.trim()
              ? t('skillsTab.noResults', { defaultValue: 'No results.' })
              : t('skillsTab.searchHint', { defaultValue: 'Type to search clawhub.com.' })}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {results.map((r) => {
              const isForce = forceForSlug === r.slug;
              const isInstalling = installing === r.slug;
              return (
                <li key={r.slug} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate font-medium text-[13px]">{r.name}</span>
                      <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{r.slug}</span>
                      {r.score ? (
                        <span className="text-[10px] text-neutral-400 dark:text-neutral-600">· {r.score.toFixed(2)}</span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isInstalling}
                    onClick={() => install(r.slug, isForce)}
                    className={cn(
                      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-white transition disabled:opacity-50',
                      isForce ? 'bg-amber-600 hover:bg-amber-500' : 'bg-neutral-900 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300',
                    )}
                  >
                    {isInstalling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                    ) : (
                      <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                    <span>
                      {isInstalling
                        ? t('skillsTab.installing', { defaultValue: 'Installing…' })
                        : isForce
                          ? t('skillsTab.installForce', { defaultValue: 'Install (force)' })
                          : t('skillsTab.install', { defaultValue: 'Install' })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

type ValidationIssue = { code: string; message: string };
type ValidationResult = {
  ok: boolean;
  hardFails: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: { fileCount: number; totalBytes: number };
  frontmatter: Record<string, unknown> | null;
  sourcePath?: string;
};

type PickedFiles = { rootName: string; files: File[]; manifest: { relativePath: string; size: number }[]; skillMd: string | null } | null;

type BatchCandidate = {
  folderName: string;
  hasSkillMd: boolean;
  name: string | null;
  description: string | null;
  fileCount: number;
  totalSize: number;
  files: File[];
  sourcePath?: string;
};

type BatchResultStatus = 'pending' | 'importing' | 'success' | 'error';
type BatchResult = { folderName: string; status: BatchResultStatus; error?: string };

function parseFrontmatterFields(content: string): { name: string | null; description: string | null } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return { name: null, description: null };
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : null,
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : null,
  };
}

function ImportFromFolder({
  projectAvailable,
  projectPath,
  onImported,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onImported: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  // Two input modes:
  //  - picked:    user clicked "Pick folder…" and the browser handed us
  //               File objects with webkitRelativePath. Always uses the
  //               multipart upload endpoint; symlink mode is unavailable
  //               because we don't have an absolute filesystem path.
  //  - typed:     user typed an absolute path; uses the JSON /import
  //               endpoint and supports both copy + symlink modes.
  const [sourcePath, setSourcePath] = useState('');
  const [picked, setPicked] = useState<PickedFiles>(null);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [scope, setScope] = useState<'user' | 'project'>(projectAvailable ? 'project' : 'user');
  const [mode, setMode] = useState<'copy' | 'symlink'>('copy');
  const [force, setForce] = useState(false);
  const [importing, setImporting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const validationDebounceRef = useRef<number | undefined>(undefined);

  // Batch import state
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[] | null>(null);
  const [batchParentName, setBatchParentName] = useState('');
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [batchImporting, setBatchImporting] = useState(false);
  const [batchResults, setBatchResults] = useState<Map<string, BatchResult>>(new Map());
  const [batchDone, setBatchDone] = useState(false);
  const [scanning, setScanning] = useState(false);

  const batchMode = batchCandidates !== null;

  useEffect(() => {
    if (!projectAvailable && scope === 'project') setScope('user');
  }, [projectAvailable, scope]);
  const skillCandidates = batchCandidates?.filter((c) => c.hasSkillMd) ?? [];
  const selectedCount = selectedFolders.size;

  // Slug auto-fill: from picked-folder name OR typed-path basename.
  useEffect(() => {
    if (slugTouched) return;
    if (picked) {
      setSlug(picked.rootName);
      return;
    }
    const cleaned = sourcePath.trim().replace(/\/+$/, '');
    setSlug(cleaned ? (cleaned.split('/').filter(Boolean).pop() || '') : '');
  }, [picked, sourcePath, slugTouched]);

  // Force "copy" when in picked mode (no source path on disk → can't symlink).
  useEffect(() => {
    if (picked && mode === 'symlink') setMode('copy');
  }, [picked, mode]);

  // Validate on input change. Debounced so typing doesn't hammer the API.
  useEffect(() => {
    if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    setErrorText(null);
    if (!picked && !sourcePath.trim()) {
      setValidation(null);
      return;
    }
    setValidating(true);
    validationDebounceRef.current = window.setTimeout(async () => {
      try {
        const body = picked
          ? { skillMdContent: picked.skillMd ?? '', files: picked.manifest }
          : { sourcePath };
        const r = await api<ValidationResult>('/api/skills/validate', body);
        setValidation(r);
      } catch (e) {
        setValidation(null);
        setErrorText((e as Error).message);
      } finally {
        setValidating(false);
      }
    }, picked ? 50 : 400);
    return () => {
      if (validationDebounceRef.current) window.clearTimeout(validationDebounceRef.current);
    };
  }, [picked, sourcePath]);

  const slugValid = !slug || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug);
  const hasInput = picked !== null || sourcePath.trim().length > 0;
  const canSubmit = hasInput && slugValid && !importing && !validating && validation?.ok === true;

  const handlePickFolder = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList);
    const firstPath = files[0]?.webkitRelativePath || '';
    const rootName = firstPath.split('/')[0] || '';

    // Check if root directory directly has SKILL.md (single skill import)
    const rootSkillFile = files.find((f) => {
      const rel = f.webkitRelativePath || f.name;
      const stripped = rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
      return stripped === 'SKILL.md';
    });

    if (rootSkillFile) {
      // Single skill — existing flow
      const manifest: { relativePath: string; size: number }[] = files.map((f) => {
        const rel = f.webkitRelativePath || f.name;
        const stripped = rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
        return { relativePath: stripped, size: f.size };
      });
      const skillMd = await rootSkillFile.text();
      setPicked({ rootName, files, manifest, skillMd });
      setSourcePath('');
      setSlugTouched(false);
      if (event.target) event.target.value = '';
      return;
    }

    // No root SKILL.md — check subdirectories for batch mode
    const subDirMap = new Map<string, File[]>();
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const stripped = rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
      const firstSeg = stripped.split('/')[0];
      if (!firstSeg || !stripped.includes('/')) continue;
      if (!subDirMap.has(firstSeg)) subDirMap.set(firstSeg, []);
      subDirMap.get(firstSeg)!.push(f);
    }

    const candidates: BatchCandidate[] = [];
    for (const [folderName, folderFiles] of subDirMap) {
      const skillFile = folderFiles.find((f) => {
        const rel = f.webkitRelativePath || f.name;
        const prefix = rootName ? rootName + '/' + folderName + '/' : folderName + '/';
        const stripped = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
        return stripped === 'SKILL.md';
      });

      let name: string | null = null;
      let description: string | null = null;
      if (skillFile) {
        const content = await skillFile.text();
        const parsed = parseFrontmatterFields(content);
        name = parsed.name;
        description = parsed.description;
      }

      candidates.push({
        folderName,
        hasSkillMd: !!skillFile,
        name,
        description,
        fileCount: folderFiles.length,
        totalSize: folderFiles.reduce((acc, f) => acc + f.size, 0),
        files: folderFiles,
      });
    }

    candidates.sort((a, b) => {
      if (a.hasSkillMd !== b.hasSkillMd) return a.hasSkillMd ? -1 : 1;
      return a.folderName.localeCompare(b.folderName);
    });

    setBatchCandidates(candidates);
    setBatchParentName(rootName);
    const skillNames = candidates.filter((c) => c.hasSkillMd).map((c) => c.folderName);
    setSelectedFolders(new Set(skillNames));
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
    setSourcePath('');
    setPicked(null);
    if (event.target) event.target.value = '';
  }, []);

  const clearPicked = useCallback(() => {
    setPicked(null);
    setValidation(null);
    setSlugTouched(false);
  }, []);

  const clearBatch = useCallback(() => {
    setBatchCandidates(null);
    setBatchParentName('');
    setSelectedFolders(new Set());
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
  }, []);

  const handleScan = useCallback(async () => {
    if (!sourcePath.trim()) return;
    setScanning(true);
    try {
      const r = await api<{ parentPath: string; folders: Array<{
        folderName: string; hasSkillMd: boolean; name: string | null;
        description: string | null; sourcePath: string; fileCount: number; totalSize: number;
      }> }>('/api/skills/scan', { parentPath: sourcePath.trim() });
      const candidates: BatchCandidate[] = r.folders.map((f) => ({
        ...f,
        files: [],
      }));
      setBatchCandidates(candidates);
      setBatchParentName(sourcePath.trim().split('/').filter(Boolean).pop() || sourcePath.trim());
      const skillNames = candidates.filter((c) => c.hasSkillMd).map((c) => c.folderName);
      setSelectedFolders(new Set(skillNames));
      setBatchResults(new Map());
      setBatchDone(false);
      setBatchImporting(false);
      setPicked(null);
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [sourcePath]);

  const handleToggleFolder = useCallback((folderName: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    if (!batchCandidates) return;
    const skills = batchCandidates.filter((c) => c.hasSkillMd);
    const allSelected = skills.every((c) => selectedFolders.has(c.folderName));
    if (allSelected) {
      setSelectedFolders(new Set());
    } else {
      setSelectedFolders(new Set(skills.map((c) => c.folderName)));
    }
  }, [batchCandidates, selectedFolders]);

  const submitBatch = useCallback(async () => {
    if (!batchCandidates || selectedCount === 0) return;
    setBatchImporting(true);
    setBatchDone(false);
    const selected = batchCandidates.filter((c) => c.hasSkillMd && selectedFolders.has(c.folderName));

    const results = new Map<string, BatchResult>();
    for (const c of selected) {
      results.set(c.folderName, { folderName: c.folderName, status: 'pending' });
    }
    setBatchResults(new Map(results));

    let successCount = 0;
    let failCount = 0;

    for (const candidate of selected) {
      results.set(candidate.folderName, { folderName: candidate.folderName, status: 'importing' });
      setBatchResults(new Map(results));

      try {
        const effectiveScope = projectAvailable ? scope : 'user';
        if (candidate.sourcePath) {
          // Scan mode — use path-based import
          await api<{ ok: boolean }>('/api/skills/import', {
            sourcePath: candidate.sourcePath,
            slug: candidate.folderName,
            scope: effectiveScope,
            projectPath: effectiveScope === 'project' ? projectPath : null,
            mode,
            force,
          });
        } else {
          // Pick folder mode — use multipart upload
          const rootName = batchParentName;
          const formData = new FormData();
          const paths: string[] = [];
          for (const file of candidate.files) {
            formData.append('files', file);
            const rel = file.webkitRelativePath || file.name;
            const prefix = rootName + '/' + candidate.folderName + '/';
            const stripped = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
            paths.push(stripped);
          }
          formData.append('paths', JSON.stringify(paths));
          formData.append('slug', candidate.folderName);
          formData.append('scope', effectiveScope);
          if (effectiveScope === 'project' && projectPath) formData.append('projectPath', projectPath);
          if (force) formData.append('force', 'true');

          const r = await authenticatedFetch('/api/skills/import-upload', {
            method: 'POST',
            body: formData,
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
          }
        }
        results.set(candidate.folderName, { folderName: candidate.folderName, status: 'success' });
        successCount++;
      } catch (e) {
        results.set(candidate.folderName, {
          folderName: candidate.folderName,
          status: 'error',
          error: (e as Error).message,
        });
        failCount++;
      }
      setBatchResults(new Map(results));
    }

    setBatchImporting(false);
    setBatchDone(true);

    if (successCount > 0) {
      onImported({
        slug: selected[0].folderName,
        name: selected[0].name || selected[0].folderName,
        scope: projectAvailable ? scope : 'user',
      });
    }
  }, [batchCandidates, selectedCount, selectedFolders, projectAvailable, scope, projectPath, mode, force, batchParentName, onImported]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setImporting(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : 'user';
      if (picked) {
        // Multipart upload path. We send the relativePath array as a
        // separate JSON field because multer drops folder paths from
        // multipart filenames.
        const formData = new FormData();
        for (let i = 0; i < picked.files.length; i++) {
          // The browser put webkitRelativePath on the File; multer only
          // surfaces basename. Append with a stable name and ferry paths
          // alongside.
          formData.append('files', picked.files[i]);
        }
        formData.append('paths', JSON.stringify(picked.manifest.map((m) => m.relativePath)));
        if (slug) formData.append('slug', slug);
        formData.append('scope', effectiveScope);
        if (effectiveScope === 'project' && projectPath) formData.append('projectPath', projectPath);
        if (force) formData.append('force', 'true');

        const r = await authenticatedFetch('/api/skills/import-upload', {
          method: 'POST',
          body: formData,
        });
        const data = await r.json().catch(() => ({} as Record<string, unknown>));
        if (!r.ok) {
          if (data.validation) setValidation(data.validation as ValidationResult);
          throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
        }
        const result = data as { slug: string; scope: 'user' | 'project'; skill: Skill | null };
        onImported({ slug: result.slug, name: result.skill?.name || result.slug, scope: result.scope });
      } else {
        // Path-based path. /api/skills/import runs the same validator
        // server-side, so a hardFail still blocks here.
        const r = await api<{
          ok: boolean;
          slug: string;
          scope: 'user' | 'project';
          skillPath: string;
          skill: Skill | null;
          mode: string;
          validation?: ValidationResult;
        }>('/api/skills/import', {
          sourcePath,
          slug: slug || undefined,
          scope: effectiveScope,
          projectPath: effectiveScope === 'project' ? projectPath : null,
          mode,
          force,
        });
        onImported({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/already exists/i.test(msg) && !force) {
        setErrorText(msg + ' ' + t('skillsTab.importEnableForce', { defaultValue: 'Enable "Overwrite" to replace it.' }));
      } else {
        setErrorText(msg);
      }
    } finally {
      setImporting(false);
    }
  }, [canSubmit, picked, sourcePath, slug, projectAvailable, scope, projectPath, mode, force, onImported, t]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Source: pick or paste */}
        <Field
          label={t('skillsTab.importSource', { defaultValue: 'Source folder' })}
          hint={!batchMode ? (t('skillsTab.importSourceHintBoth', { defaultValue: 'Pick a folder via the native dialog, or paste an absolute path. ~ is expanded server-side.' }) as string) : undefined}
        >
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={batchMode}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition',
                batchMode
                  ? 'cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900',
              )}
            >
              <Folder className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t('skillsTab.pickFolder', { defaultValue: 'Pick folder…' })}</span>
            </button>
            <button
              type="button"
              onClick={handleScan}
              disabled={!sourcePath.trim() || scanning || batchMode}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition',
                (!sourcePath.trim() || scanning || batchMode)
                  ? 'cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900',
              )}
            >
              {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <FolderSearch className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span>{scanning ? t('skillsTab.scanning', { defaultValue: 'Scanning…' }) : t('skillsTab.scan', { defaultValue: 'Scan' })}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              // @ts-expect-error webkitdirectory is non-standard but supported in Chromium/WebKit/Firefox.
              webkitdirectory=""
              directory=""
              multiple
              onChange={handleFolderSelected}
              className="hidden"
            />
            <input
              type="text"
              value={sourcePath}
              onChange={(e) => {
                setSourcePath(e.target.value);
                if (picked) setPicked(null);
                if (batchMode) clearBatch();
              }}
              placeholder="~/code/my-skill"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={picked !== null || batchMode}
              className={cn(
                'h-8 flex-1 rounded-md border bg-white px-2 font-mono text-[12px] outline-none focus:border-neutral-400 dark:bg-neutral-950 dark:focus:border-neutral-600',
                (picked || batchMode)
                  ? 'cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600'
                  : 'border-neutral-200 dark:border-neutral-800',
              )}
            />
          </div>
          {picked ? (
            <div className="mt-2 flex items-center gap-2 rounded-md bg-neutral-100 px-2.5 py-1.5 text-[12px] dark:bg-neutral-900">
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
              <div className="min-w-0 flex-1 truncate">
                <span className="font-medium">{picked.rootName}</span>
                <span className="ml-2 text-neutral-500 dark:text-neutral-400">
                  {picked.files.length} {t('skillsTab.files', { defaultValue: 'files' })} ·{' '}
                  {formatBytes(picked.manifest.reduce((acc, m) => acc + m.size, 0))}
                </span>
              </div>
              <button
                type="button"
                onClick={clearPicked}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                <X className="h-3 w-3" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </Field>

        {/* ---- Batch mode: candidate list ---- */}
        {batchMode ? (
          <div className="mt-3 rounded-md border border-neutral-200 dark:border-neutral-800">
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{batchParentName}</span>
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('skillsTab.foundSkills', {
                  defaultValue: 'Found {{count}} skills in {{total}} subfolders',
                  count: skillCandidates.length,
                  total: batchCandidates!.length,
                })}
              </span>
              <button
                type="button"
                onClick={clearBatch}
                disabled={batchImporting}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800 disabled:opacity-40"
              >
                <X className="h-3 w-3" strokeWidth={1.75} />
              </button>
            </div>

            {skillCandidates.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-neutral-500 dark:text-neutral-400">
                {t('skillsTab.noSkillsFound', { defaultValue: 'No skills found in this folder.' })}
              </div>
            ) : (
              <>
                {/* Select all */}
                {!batchDone && (
                  <div className="border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-900">
                    <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={skillCandidates.every((c) => selectedFolders.has(c.folderName))}
                        onChange={handleToggleAll}
                        disabled={batchImporting}
                      />
                      <span className="font-medium">
                        {t('skillsTab.selectAll', {
                          defaultValue: 'Select All ({{count}})',
                          count: skillCandidates.length,
                        })}
                      </span>
                    </label>
                  </div>
                )}

                {/* Progress header */}
                {batchImporting && (
                  <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-500 dark:border-neutral-900 dark:text-neutral-400">
                    {t('skillsTab.batchProgress', {
                      defaultValue: 'Importing {{current}}/{{total}}…',
                      current: Array.from(batchResults.values()).filter((r) => r.status === 'success' || r.status === 'error').length,
                      total: selectedCount,
                    })}
                  </div>
                )}
                {batchDone && (
                  <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] font-medium dark:border-neutral-900">
                    {t('skillsTab.batchComplete', {
                      defaultValue: 'Batch import complete: {{success}} succeeded, {{failed}} failed',
                      success: Array.from(batchResults.values()).filter((r) => r.status === 'success').length,
                      failed: Array.from(batchResults.values()).filter((r) => r.status === 'error').length,
                    })}
                  </div>
                )}

                {/* Candidate list */}
                <div className="max-h-[240px] overflow-y-auto">
                  {batchCandidates!.map((candidate) => {
                    const result = batchResults.get(candidate.folderName);
                    const isSkill = candidate.hasSkillMd;
                    const isSelected = selectedFolders.has(candidate.folderName);

                    return (
                      <div
                        key={candidate.folderName}
                        className={cn(
                          'flex items-start gap-2 border-b border-neutral-50 px-3 py-2 last:border-b-0 dark:border-neutral-900/50',
                          !isSkill && 'opacity-40',
                        )}
                      >
                        {isSkill && !batchDone ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleFolder(candidate.folderName)}
                            disabled={batchImporting}
                            className="mt-0.5 shrink-0"
                          />
                        ) : result ? (
                          <span className="mt-0.5 shrink-0">
                            {result.status === 'success' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" strokeWidth={1.75} />}
                            {result.status === 'error' && <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-500" strokeWidth={1.75} />}
                            {result.status === 'importing' && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />}
                            {result.status === 'pending' && <div className="h-3.5 w-3.5" />}
                          </span>
                        ) : !isSkill ? (
                          <div className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : null}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Folder className={cn('h-3 w-3 shrink-0', isSkill ? 'text-amber-500' : 'text-neutral-300 dark:text-neutral-700')} strokeWidth={1.75} />
                            <span className={cn('truncate text-[12px]', isSkill ? 'font-medium' : 'text-neutral-400 dark:text-neutral-600')}>
                              {candidate.folderName}
                            </span>
                            {!isSkill && (
                              <span className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-600">
                                ({t('skillsTab.noSkillMd', { defaultValue: 'No SKILL.md' })})
                              </span>
                            )}
                          </div>
                          {isSkill && (candidate.name || candidate.description) && (
                            <div className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                              {candidate.name && <span className="font-medium">{candidate.name}</span>}
                              {candidate.name && candidate.description && <span> — </span>}
                              {candidate.description && <span>{candidate.description}</span>}
                            </div>
                          )}
                          {isSkill && (
                            <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                              {candidate.fileCount} {t('skillsTab.files', { defaultValue: 'files' })} · {formatBytes(candidate.totalSize)}
                            </div>
                          )}
                          {result?.status === 'error' && result.error && (
                            <div className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400">{result.error}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Batch controls */}
            {skillCandidates.length > 0 && !batchDone && (
              <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <div className="flex items-center justify-between gap-3">
                  <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
                  <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} disabled={batchImporting} />
                    <span>{t('skillsTab.importForce', { defaultValue: 'Overwrite if exists' })}</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ---- Single import mode (existing UI) ---- */}
            <Field
              label={t('skillsTab.importSlug', { defaultValue: 'Slug (target folder name)' })}
              hint={t('skillsTab.importSlugHint', { defaultValue: 'Defaults to the source folder name. Edit to override.' }) as string}
            >
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                placeholder="my-skill"
                className={cn(
                  'h-8 w-full rounded-md border bg-white px-2 font-mono text-[12px] outline-none dark:bg-neutral-950',
                  slugValid
                    ? 'border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600'
                    : 'border-red-300 dark:border-red-800',
                )}
              />
            </Field>

            <Field label={t('skillsTab.importMode', { defaultValue: 'Import mode' })}>
              <div className="flex flex-col gap-1.5 text-[12px]">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'copy'}
                    onChange={() => setMode('copy')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{t('skillsTab.importModeCopy', { defaultValue: 'Copy' })}</span>
                    <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                      {t('skillsTab.importModeCopyHint', { defaultValue: '— independent copy, edits live in the skills folder.' })}
                    </span>
                  </span>
                </label>
                <label className={cn('flex items-start gap-2', picked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'symlink'}
                    disabled={picked !== null}
                    onChange={() => setMode('symlink')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{t('skillsTab.importModeSymlink', { defaultValue: 'Symlink' })}</span>
                    <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                      {picked
                        ? t('skillsTab.symlinkUnavailable', { defaultValue: '— unavailable for picker uploads (no source path on disk).' })
                        : t('skillsTab.importModeSymlinkHint', { defaultValue: '— edits in the source folder propagate live; deleting the source breaks the skill.' })}
                    </span>
                  </span>
                </label>
              </div>
            </Field>

            <ValidationPanel result={validation} validating={validating} t={t} />

            <div className="mt-4 flex items-center justify-between gap-3">
              <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>{t('skillsTab.importForce', { defaultValue: 'Overwrite if exists' })}</span>
              </label>
            </div>
          </>
        )}

        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
        {batchMode ? (
          batchDone ? (
            <button
              type="button"
              onClick={() => {
                clearBatch();
                onImported({ slug: '', name: '', scope });
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t('skillsTab.batchDone', { defaultValue: 'Done' })}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={submitBatch}
              disabled={selectedCount === 0 || batchImporting}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {batchImporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              <span>
                {batchImporting
                  ? t('skillsTab.importing', { defaultValue: 'Importing…' })
                  : t('skillsTab.importNSkills', { defaultValue: 'Import {{count}} skills', count: selectedCount })}
              </span>
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <FolderInput className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            <span>
              {importing
                ? t('skillsTab.importing', { defaultValue: 'Importing…' })
                : t('skillsTab.importAction', { defaultValue: 'Import skill' })}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function ValidationPanel({
  result,
  validating,
  t,
}: {
  result: ValidationResult | null;
  validating: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (!result && !validating) return null;
  return (
    <div className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 text-[12px] font-medium dark:border-neutral-800">
        <ShieldCheck className="h-3.5 w-3.5 text-neutral-500" strokeWidth={1.75} />
        <span>{t('skillsTab.complianceCheck', { defaultValue: 'Compliance check' })}</span>
        {validating ? (
          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
        ) : result?.ok ? (
          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" strokeWidth={1.75} />
        ) : (
          <XCircle className="ml-auto h-3.5 w-3.5 text-red-600 dark:text-red-500" strokeWidth={1.75} />
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[12px]">
        {result?.stats ? (
          <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
            <span>{result.stats.fileCount} {t('skillsTab.files', { defaultValue: 'files' })}</span>
            <span>·</span>
            <span>{formatBytes(result.stats.totalBytes)}</span>
            {result.frontmatter && (result.frontmatter as { name?: string }).name ? (
              <>
                <span>·</span>
                <span className="truncate">name: <span className="font-mono">{(result.frontmatter as { name: string }).name}</span></span>
              </>
            ) : null}
          </div>
        ) : null}
        {result?.hardFails && result.hardFails.length > 0 ? (
          <ul className="space-y-1">
            {result.hardFails.map((iss, i) => (
              <li key={`f${i}`} className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
                <XCircle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.warnings && result.warnings.length > 0 ? (
          <ul className="space-y-1">
            {result.warnings.map((iss, i) => (
              <li key={`w${i}`} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.ok && (!result.warnings || result.warnings.length === 0) ? (
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
            <span>{t('skillsTab.complianceClean', { defaultValue: 'All checks passed.' })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function CreateFromScratch({
  projectAvailable,
  projectPath,
  onCreated,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onCreated: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>(projectAvailable ? 'project' : 'user');
  const [creating, setCreating] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!projectAvailable && scope === 'project') setScope('user');
  }, [projectAvailable, scope]);

  const slugValid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug);
  const canSubmit = slugValid && (description.trim().length > 0 || body.trim().length > 0);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setCreating(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : 'user';
      const r = await api<{ ok: boolean; slug: string; scope: 'user' | 'project'; skill: Skill }>(
        '/api/skills/create',
        {
          slug,
          name: name.trim() || slug,
          description,
          body,
          scope: effectiveScope,
          projectPath: effectiveScope === 'project' ? projectPath : null,
        },
      );
      onCreated({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [canSubmit, slug, name, description, body, projectAvailable, scope, projectPath, onCreated]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('skillsTab.fieldSlug', { defaultValue: 'Slug' })} hint={t('skillsTab.slugHint', { defaultValue: 'Folder name, e.g. my-skill' }) as string}>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-skill"
              className={cn(
                'h-8 w-full rounded-md border bg-white px-2 font-mono text-[13px] outline-none dark:bg-neutral-950',
                slugValid || !slug
                  ? 'border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600'
                  : 'border-red-300 dark:border-red-800',
              )}
            />
          </Field>
          <Field label={t('skillsTab.fieldName', { defaultValue: 'Display name' })}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={slug || t('skillsTab.fieldNamePlaceholder', { defaultValue: 'Optional, defaults to slug' }) as string}
              className="h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-[13px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            />
          </Field>
        </div>
        <Field label={t('skillsTab.fieldDescription', { defaultValue: 'Description' })} hint={t('skillsTab.descHint', { defaultValue: 'Shown in the slash menu — describe what this skill does and when to invoke it.' }) as string}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
          />
        </Field>
        <Field label={t('skillsTab.fieldBody', { defaultValue: 'Initial body (Markdown)' })} hint={t('skillsTab.bodyHint', { defaultValue: 'Optional. Edit in detail later from the main view.' }) as string}>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[12px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            placeholder={'# My Skill\n\nDescribe what this skill does...'}
          />
        </Field>
        <div className="mt-3">
          <ScopeSelector scope={scope} onChange={setScope} projectAvailable={projectAvailable} t={t} />
        </div>
        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || creating}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />}
          <span>{creating ? t('skillsTab.creating', { defaultValue: 'Creating…' }) : t('skillsTab.create', { defaultValue: 'Create skill' })}</span>
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-[12px] font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
    </div>
  );
}
