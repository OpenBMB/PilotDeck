import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  Copy,
  Download,
  Folder,
  FolderInput,
  FolderSearch,
  Globe,
  Loader2,
  MoreHorizontal,
  PanelLeftOpen,
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
import { useConfirm } from '../ui/ConfirmDialog';
import type { Project } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';
import { useTheme } from '../../contexts/ThemeContext';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import type { ConversationSkill } from '../../contexts/SkillConversationContext';
import { cn } from '../../lib/utils.js';
import SkillDialog from './SkillDialog';
import SkillMarkdown from './SkillMarkdown';
import SkillReader from './SkillReader';
import SkillForm from './SkillForm';
import { canEditSkillForm, splitSkillDocument } from './skillDocument';
import './SkillsV2.css';

type SkillsV2Props = {
  selectedProject: Project | null;
  projects: Project[];
  compact?: boolean;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
  onProjectChange?: (project: Project | null) => void;
  onUseSkill?: (skill: ConversationSkill, project: Project | null) => void;
};

type SkillScope = 'builtin' | 'user' | 'project';

type Skill = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  skillFile: string;
  skillDir: string;
  scope: SkillScope;
  readonly: boolean;
  overriddenBy?: 'user' | 'project';
  overridesBuiltin?: boolean;
  mtime: number | null;
};

type SkillsListResponse = {
  builtin: Skill[];
  user: Skill[];
  project: Skill[];
  projectPath: string | null;
  isGeneralCwd: boolean;
};

type SearchResult = { slug: string; owner?: string; name: string; score: number | null };

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
// Keep drafts during in-app navigation; browser reloads are guarded below.
const skillDrafts = new Map<string, { content: string; original: string }>();

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
    const message =
      (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message ||
      `Request failed (${r.status})`;
    throw new Error(message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------

export default function SkillsV2({
  selectedProject,
  projects,
  compact = false,
  isSidebarCollapsed,
  onOpenSidebar,
  onProjectChange,
  onUseSkill,
}: SkillsV2Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };

  const cwd = projectCwd(selectedProject);
  const localGeneralCwd = isGeneralProject(selectedProject);
  const draftConflictMessage = t('skillsTab.draftConflict');

  const [skills, setSkills] = useState<SkillsListResponse | null>(null);
  const [serverGeneralCwdPath, setServerGeneralCwdPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<SkillScope | null>(null);
  const [editorContent, setEditorContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState(false);
  const [readReady, setReadReady] = useState(false);
  const [readRetry, setReadRetry] = useState(0);
  const listRequest = useRef(0);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [overrideScope, setOverrideScope] = useState<'user' | 'project'>('user');
  const [showOverride, setShowOverride] = useState(false);
  const [creatingOverride, setCreatingOverride] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 680px)').matches ?? false,
  );
  const compactLayout = compact || narrow;

  const serverGeneralCwd = Boolean(cwd && serverGeneralCwdPath === cwd);
  const generalCwd = localGeneralCwd || serverGeneralCwd;
  const effectiveProjectPath = generalCwd ? null : cwd;
  const previousProjectPath = useRef(effectiveProjectPath);
  const projectContext = useMemo(
    () => ({ projectPath: effectiveProjectPath }),
    [effectiveProjectPath],
  );
  const currentProjectContext = useRef(projectContext);
  currentProjectContext.current = projectContext;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrentContext = useCallback(
    () => mounted.current && currentProjectContext.current === projectContext,
    [projectContext],
  );

  const flashToast = useCallback((toastValue: ToastState, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!isCurrentContext()) return;
    const requestId = ++listRequest.current;
    setLoading(true);
    try {
      const data = await api<SkillsListResponse>('/api/skills/list', {
        projectPath: effectiveProjectPath,
      });
      if (!isCurrentContext() || requestId !== listRequest.current) return;
      setSkills(data);
      setServerGeneralCwdPath((prev) => {
        if (!cwd) return null;
        if (data.isGeneralCwd) return cwd;
        if (effectiveProjectPath === null && (localGeneralCwd || prev === cwd)) return prev;
        return prev === cwd ? null : prev;
      });
    } catch (e) {
      if (isCurrentContext() && requestId === listRequest.current)
        flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      if (isCurrentContext() && requestId === listRequest.current) setLoading(false);
    }
  }, [cwd, effectiveProjectPath, flashToast, localGeneralCwd, isCurrentContext]);

  const invalidateListRequests = useCallback(() => {
    listRequest.current++;
  }, []);

  useEffect(() => {
    // General context hydration does not change the visible skill scope.
    if (previousProjectPath.current !== effectiveProjectPath) {
      previousProjectPath.current = effectiveProjectPath;
      setSkills(null);
      setActiveSlug(null);
      setActiveScope(null);
      setSaving(false);
      setShowNew(false);
      setShowOverride(false);
      setCreatingOverride(false);
    }
    void refresh();
    return invalidateListRequests;
  }, [refresh, effectiveProjectPath, invalidateListRequests]);

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 680px)');
    if (!media) return;
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (compactLayout || activeSlug || !skills) return;
    const first = (!generalCwd && skills.project[0]) || skills.user[0] || skills.builtin[0];
    if (first) {
      setActiveSlug(first.slug);
      setActiveScope(first.scope);
    }
  }, [skills, activeSlug, compactLayout, generalCwd]);

  useEffect(() => {
    if (generalCwd && activeScope === 'project') {
      setActiveScope(null);
      setActiveSlug(null);
    }
  }, [activeScope, generalCwd]);

  const activeSkill = useMemo(() => {
    if (!skills || !activeSlug) return null;
    const list =
      activeScope === 'builtin'
        ? skills.builtin
        : activeScope === 'project'
          ? skills.project
          : skills.user;
    return list.find((s) => s.slug === activeSlug) ?? null;
  }, [skills, activeSlug, activeScope]);

  const activeSkillPath = activeSkill?.skillDir;
  const activeSkillScope = activeSkill?.scope;
  const activeSkillSlug = activeSkill?.slug;
  // Metadata refreshes must not discard an open draft.
  useEffect(() => {
    setEditing(false);
    setReadReady(false);
    setDetailError(null);
    if (!activeSkillPath || !activeSkillScope || !activeSkillSlug) {
      setEditorContent('');
      setOriginalContent('');
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    api<{ content: string }>('/api/skills/read', {
      scope: activeSkillScope,
      slug: activeSkillSlug,
      projectPath: effectiveProjectPath,
    })
      .then((data) => {
        if (cancelled) return;
        setReadReady(true);
        const draft = skillDrafts.get(activeSkillPath);
        setEditorContent(draft?.content ?? data.content);
        setOriginalContent(data.content);
        if (draft) {
          setEditing(true);
          if (draft.original !== data.content) setDetailError(draftConflictMessage);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        flashToast({ kind: 'error', text: (e as Error).message });
        setDetailError((e as Error).message);
        setEditorContent('');
        setOriginalContent('');
      })
      .finally(() => {
        if (!cancelled) setEditorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSkillPath,
    activeSkillScope,
    activeSkillSlug,
    effectiveProjectPath,
    flashToast,
    draftConflictMessage,
    readRetry,
  ]);

  const isDirty = editorContent !== originalContent;

  useEffect(() => {
    if (!isDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [isDirty]);

  const handleSave = useCallback(async () => {
    if (!activeSkill || !isCurrentContext()) return;
    setSaving(true);
    setDetailError(null);
    try {
      const result = await api<{ ok: boolean; skill: Skill }>('/api/skills/write', {
        scope: activeSkill.scope,
        slug: activeSkill.slug,
        projectPath: effectiveProjectPath,
        content: editorContent,
      });
      skillDrafts.delete(activeSkill.skillDir);
      if (!isCurrentContext()) return;
      setOriginalContent(editorContent);
      // Patch the skill in-place so list metadata (name/desc) refreshes.
      setSkills((prev) => {
        if (!prev) return prev;
        const updateIn = (list: Skill[]) =>
          list.map((s) =>
            s.slug === activeSkill.slug && s.scope === activeSkill.scope
              ? { ...s, ...result.skill, scope: activeSkill.scope }
              : s,
          );
        return {
          ...prev,
          user: updateIn(prev.user),
          project: updateIn(prev.project),
        };
      });
      flashToast({ kind: 'success', text: t('skillsTab.savedSuccess', { defaultValue: 'Saved' }) });
      setEditing(false);
    } catch (e) {
      if (!isCurrentContext()) return;
      setDetailError((e as Error).message);
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      if (isCurrentContext()) setSaving(false);
    }
  }, [activeSkill, editorContent, effectiveProjectPath, flashToast, t, isCurrentContext]);

  const handleDelete = useCallback(async () => {
    if (!activeSkill || activeSkill.readonly || !isCurrentContext()) return;
    if (
      !(await confirm({
        message: t('skillsTab.confirmDelete', {
          defaultValue: 'Delete this skill? This will remove the entire folder.',
          name: activeSkill.name,
        }) as string,
        destructive: true,
        confirmLabel: t('confirmDialog.delete'),
      }))
    ) {
      return;
    }
    if (!isCurrentContext()) return;
    try {
      await api('/api/skills/delete', {
        scope: activeSkill.scope,
        slug: activeSkill.slug,
        projectPath: effectiveProjectPath,
      });
      skillDrafts.delete(activeSkill.skillDir);
      if (!isCurrentContext()) return;
      setActiveSlug(null);
      setActiveScope(null);
      await refresh();
      if (!isCurrentContext()) return;
      flashToast({
        kind: 'success',
        text: t('skillsTab.deletedSuccess', { defaultValue: 'Deleted' }),
      });
    } catch (e) {
      if (!isCurrentContext()) return;
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [activeSkill, effectiveProjectPath, refresh, flashToast, t, confirm, isCurrentContext]);

  const handleCreateOverride = useCallback(async () => {
    if (!activeSkill || activeSkill.scope !== 'builtin' || !isCurrentContext()) return;
    setCreatingOverride(true);
    setDetailError(null);
    const scope = effectiveProjectPath ? overrideScope : 'user';
    try {
      const result = await api<{ skill: Skill }>('/api/skills/import', {
        sourceSkill: {
          scope: activeSkill.scope,
          slug: activeSkill.slug,
          projectPath: effectiveProjectPath,
        },
        slug: activeSkill.slug,
        scope,
        projectPath: scope === 'project' ? effectiveProjectPath : null,
        mode: 'copy',
        force: false,
      });
      if (!isCurrentContext()) return;
      await refresh();
      if (!isCurrentContext()) return;
      setActiveSlug(activeSkill.slug);
      setActiveScope(scope);
      setShowOverride(false);
      flashToast({
        kind: 'success',
        text: t('skillsTab.overrideCreated', {
          name: result.skill?.name || activeSkill.name,
        }) as string,
      });
    } catch (e) {
      if (!isCurrentContext()) return;
      setDetailError((e as Error).message);
    } finally {
      if (isCurrentContext()) setCreatingOverride(false);
    }
  }, [activeSkill, effectiveProjectPath, overrideScope, flashToast, refresh, t, isCurrentContext]);

  const handleSelect = useCallback(
    async (skill: Skill) => {
      if (saving || !isCurrentContext()) return;
      if (skill.slug === activeSlug && skill.scope === activeScope) return;
      if (isDirty) {
        if (
          !(await confirm({
            message: t('skillsTab.discardUnsaved', {
              defaultValue: 'Discard unsaved changes?',
            }) as string,
            destructive: true,
            confirmLabel: t('confirmDialog.discard'),
          }))
        ) {
          return;
        }
        if (!isCurrentContext()) return;
        if (activeSkillPath) skillDrafts.delete(activeSkillPath);
      }
      setActiveSlug(skill.slug);
      setActiveScope(skill.scope);
    },
    [activeSlug, activeScope, activeSkillPath, isDirty, saving, t, confirm, isCurrentContext],
  );

  const discardDraft = async () => {
    if (!isCurrentContext()) return false;
    if (
      saving ||
      (isDirty &&
        !(await confirm({
          message: t('skillsTab.discardUnsaved'),
          destructive: true,
          confirmLabel: t('confirmDialog.discard'),
        })))
    )
      return false;
    if (!isCurrentContext()) return false;
    if (activeSkillPath) skillDrafts.delete(activeSkillPath);
    setEditorContent(originalContent);
    setEditing(false);
    return true;
  };

  // ------------------------------------------------------------------------

  return (
    <div className={cn('skills-workbench skills-page', compactLayout && 'compact')}>
      <Header
        projectName={selectedProject?.displayName || selectedProject?.name || null}
        generalCwd={generalCwd}
        loading={loading || saving}
        onRefresh={refresh}
        onNew={async () => {
          if (await discardDraft()) setShowNew(true);
        }}
        projects={projects}
        selectedProject={selectedProject}
        onProjectChange={
          onProjectChange
            ? async (project) => {
                if (!(await discardDraft())) return;
                setSkills(null);
                setActiveSlug(null);
                setActiveScope(null);
                onProjectChange(project);
              }
            : undefined
        }
        isSidebarCollapsed={isSidebarCollapsed}
        onOpenSidebar={onOpenSidebar}
        t={t}
      />

      <div className="skills-layout">
        {!compactLayout || !activeSkill ? (
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
            compact={compactLayout}
            beforeMutation={async (skill) =>
              isCurrentContext() && (skill.skillDir !== activeSkillPath || (await discardDraft()))
            }
            isCurrentContext={isCurrentContext}
            t={t}
          />
        ) : null}
        {!compactLayout || activeSkill ? (
          <div className="skills-detail">
            {compactLayout && activeSkill ? (
              <button
                type="button"
                onClick={async () => {
                  if (
                    isDirty &&
                    !(await confirm({
                      message: t('skillsTab.discardUnsaved', {
                        defaultValue: 'Discard unsaved changes?',
                      }) as string,
                      destructive: true,
                      confirmLabel: t('confirmDialog.discard'),
                    }))
                  )
                    return;
                  if (activeSkillPath) skillDrafts.delete(activeSkillPath);
                  setActiveSlug(null);
                  setActiveScope(null);
                }}
                className="flex h-9 shrink-0 items-center gap-1.5 border-b border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t('skillsTab.backToSkills', { defaultValue: 'Back to skills' })}</span>
              </button>
            ) : null}
            {activeSkill ? (
              <SkillDetail
                skill={activeSkill}
                content={editorContent}
                onChange={(content) => {
                  setEditorContent(content);
                  if (activeSkillPath) {
                    if (content === originalContent) skillDrafts.delete(activeSkillPath);
                    else skillDrafts.set(activeSkillPath, { content, original: originalContent });
                  }
                }}
                isDirty={isDirty}
                loading={editorLoading}
                saving={saving}
                editing={editing}
                error={detailError}
                readReady={readReady}
                onRetry={() => setReadRetry((value) => value + 1)}
                projectPath={effectiveProjectPath}
                onUseSkill={
                  onUseSkill &&
                  (projectCwd(selectedProject) ||
                    projects.some((project) => isGeneralProject(project) && projectCwd(project)))
                    ? async () => {
                        if (await discardDraft())
                          onUseSkill(
                            {
                              slug: activeSkill.slug,
                              name: activeSkill.name,
                              command: `/${activeSkill.slug}`,
                            },
                            selectedProject,
                          );
                      }
                    : undefined
                }
                isDarkMode={isDarkMode}
                onSave={handleSave}
                onDelete={handleDelete}
                onEdit={() => {
                  setEditing(true);
                  setDetailError(null);
                }}
                onCreateOverride={() => {
                  setOverrideScope(effectiveProjectPath ? 'project' : 'user');
                  setDetailError(null);
                  setShowOverride(true);
                }}
                onCancel={async () => {
                  if (
                    isDirty &&
                    !(await confirm({
                      message: t('skillsTab.discardUnsaved'),
                      destructive: true,
                      confirmLabel: t('confirmDialog.discard'),
                    }))
                  )
                    return;
                  if (activeSkillPath) skillDrafts.delete(activeSkillPath);
                  setEditorContent(originalContent);
                  setEditing(false);
                  setDetailError(null);
                }}
                t={t}
              />
            ) : (
              <EmptyState t={t} />
            )}
          </div>
        ) : null}
      </div>

      {showNew ? (
        <NewSkillModal
          onClose={() => setShowNew(false)}
          onBatchChanged={refresh}
          onCreated={async (created) => {
            if (!isCurrentContext()) return;
            await refresh();
            if (!isCurrentContext()) return;
            if (created.slug) {
              setActiveSlug(created.slug);
              setActiveScope(created.scope);
            }
            setShowNew(false);
            if (created.slug)
              flashToast({
                kind: 'success',
                text: t('skillsTab.installedSuccess', {
                  defaultValue: 'Installed',
                  name: created.name,
                }),
              });
          }}
          projectAvailable={Boolean(effectiveProjectPath)}
          projectPath={effectiveProjectPath}
          t={t}
        />
      ) : null}

      {showOverride && activeSkill ? (
        <SkillDialog
          small
          title={t('skillsTab.createOverride')}
          description={t('skillsTab.customizeDescription')}
          onClose={() => {
            setShowOverride(false);
            setDetailError(null);
          }}
          busy={creatingOverride}
        >
          <div className="skills-dialog-content">
            <ScopeSelector
              scope={overrideScope}
              onChange={setOverrideScope}
              projectAvailable={Boolean(effectiveProjectPath)}
              t={t}
            />
            <p className="mt-4 text-[12px] text-muted-foreground">
              {t('skillsTab.overrideExplanation')}
            </p>
            {detailError ? (
              <p role="alert" className="mt-3 text-[12px] text-destructive">
                {detailError}
              </p>
            ) : null}
          </div>
          <footer className="skills-dialog-footer">
            <button
              type="button"
              className="skills-button"
              disabled={creatingOverride}
              onClick={() => setShowOverride(false)}
            >
              {t('skillsTab.cancel')}
            </button>
            <button
              type="button"
              className="skills-button skills-button-primary"
              disabled={creatingOverride}
              onClick={handleCreateOverride}
            >
              {creatingOverride ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Copy size={15} />
              )}
              {t('skillsTab.createOverride')}
            </button>
          </footer>
        </SkillDialog>
      ) : null}

      {toast ? (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
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
  projectName,
  projects,
  selectedProject,
  onProjectChange,
  generalCwd,
  loading,
  onRefresh,
  onNew,
  t,
  onOpenSidebar,
  isSidebarCollapsed,
}: {
  projectName: string | null;
  projects: Project[];
  selectedProject: Project | null;
  onProjectChange?: (project: Project | null) => void;
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
  onNew: () => void;
  t: ReturnType<typeof useTranslation>['t'];
  onOpenSidebar?: () => void;
  isSidebarCollapsed?: boolean;
}) {
  return (
    <>
      <header className="skills-header">
        <div className="flex min-w-0 items-center gap-3">
          {isSidebarCollapsed ? (
            <button
              type="button"
              className="skills-icon-button"
              onClick={onOpenSidebar}
              aria-label={t('sidebar:tooltips.showSidebar')}
            >
              <PanelLeftOpen size={18} />
            </button>
          ) : null}
          <div>
            <h2>{t('skillsTab.title')}</h2>
            <p>{t('skillsTab.subtitle')}</p>
          </div>
        </div>
        <div className="skills-header-actions">
          <button
            type="button"
            className="skills-icon-button"
            disabled={loading}
            onClick={onRefresh}
            aria-label={t('skillsTab.refresh')}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" className="skills-button skills-button-primary" onClick={onNew}>
            <Plus size={16} />
            {t('skillsTab.newSkill')}
          </button>
        </div>
      </header>
      <div className="skills-context">
        <Folder size={14} />
        {onProjectChange ? (
          <label className="skills-project-selector">
            <span>{t('skillsTab.projectContext')}</span>
            <select
              aria-label={t('skillsTab.switchProject')}
              value={isGeneralProject(selectedProject) ? '' : (selectedProject?.name ?? '')}
              disabled={loading}
              onChange={(event) =>
                onProjectChange(
                  projects.find((project) => project.name === (event.target.value || 'general')) ??
                    null,
                )
              }
            >
              <option value="">{t('skillsTab.generalChat')}</option>
              {projects
                .filter((project) => !isGeneralProject(project))
                .map((project) => (
                  <option key={project.name} value={project.name}>
                    {project.displayName || project.name}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <span>
            {projectName && !generalCwd
              ? t('skillsTab.currentProject', { name: projectName })
              : t('skillsTab.generalChat')}
          </span>
        )}
      </div>
    </>
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
  compact,
  beforeMutation,
  isCurrentContext,
  t,
}: {
  skills: SkillsListResponse | null;
  loading: boolean;
  activeSlug: string | null;
  activeScope: SkillScope | null;
  generalCwd: boolean;
  onSelect: (s: Skill) => void;
  selectedSkill: Skill | null;
  effectiveProjectPath: string | null;
  projects: Project[];
  refresh: () => Promise<void>;
  flashToast: (t: ToastState, ms?: number) => void;
  setActiveSlug: (slug: string | null) => void;
  setActiveScope: (scope: SkillScope | null) => void;
  compact: boolean;
  beforeMutation: (skill: Skill) => Promise<boolean>;
  isCurrentContext: () => boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<SkillScope | 'all'>('all');
  const matchingSkills = useMemo(() => {
    const matches = (skill: Skill) =>
      `${skill.name} ${skill.slug} ${skill.description}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
    return {
      builtin: skills?.builtin.filter(matches) ?? [],
      user: skills?.user.filter(matches) ?? [],
      project: generalCwd ? [] : (skills?.project.filter(matches) ?? []),
    };
  }, [skills, query, generalCwd]);
  const sections = [
    {
      scope: 'project' as const,
      title: t('skillsTab.projectScope'),
      items: matchingSkills.project,
    },
    { scope: 'user' as const, title: t('skillsTab.userScope'), items: matchingSkills.user },
    {
      scope: 'builtin' as const,
      title: t('skillsTab.builtinScope'),
      items: matchingSkills.builtin,
    },
  ].filter(
    (section) =>
      (scopeFilter === 'all' || scopeFilter === section.scope) && section.items.length > 0,
  );

  const handleDeleteSkill = useCallback(
    async (skill: Skill) => {
      if (skill.readonly) return;
      if (
        !(await confirm({
          message: t('skillsTab.confirmUninstall', {
            defaultValue: 'Uninstall "{{name}}"? This will remove the entire skill folder.',
            name: skill.name,
          }) as string,
          destructive: true,
          confirmLabel: t('confirmDialog.delete'),
        }))
      ) {
        return;
      }
      if (!(await beforeMutation(skill))) return;
      try {
        await api('/api/skills/delete', {
          scope: skill.scope,
          slug: skill.slug,
          projectPath: effectiveProjectPath,
        });
        if (!isCurrentContext()) return;
        if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
          setActiveSlug(null);
          setActiveScope(null);
        }
        await refresh();
        if (!isCurrentContext()) return;
        flashToast({
          kind: 'success',
          text: t('skillsTab.uninstallSuccess', {
            defaultValue: 'Uninstalled "{{name}}"',
            name: skill.name,
          }) as string,
        });
      } catch (e) {
        if (!isCurrentContext()) return;
        flashToast({ kind: 'error', text: (e as Error).message });
      }
    },
    [
      effectiveProjectPath,
      selectedSkill,
      refresh,
      flashToast,
      setActiveSlug,
      setActiveScope,
      t,
      confirm,
      beforeMutation,
      isCurrentContext,
    ],
  );

  const handleMoveSkill = useCallback(
    async (skill: Skill, target: MoveTarget) => {
      if (skill.readonly) return;
      if (!(await beforeMutation(skill))) return;
      try {
        await api('/api/skills/import', {
          sourceSkill: { scope: skill.scope, slug: skill.slug, projectPath: effectiveProjectPath },
          slug: skill.slug,
          scope: target.scope,
          projectPath: target.projectPath,
          mode: 'copy',
          force: false,
        });
        await api('/api/skills/delete', {
          scope: skill.scope,
          slug: skill.slug,
          projectPath: effectiveProjectPath,
        });
        if (!isCurrentContext()) return;
        if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
          if (target.scope === 'project' && target.projectPath !== effectiveProjectPath) {
            setActiveSlug(null);
            setActiveScope(null);
          } else setActiveScope(target.scope);
        }
        await refresh();
        if (!isCurrentContext()) return;
        const label =
          target.scope === 'user'
            ? t('uiText.userScope')
            : target.projectPath.split('/').pop() || t('uiText.projectScope');
        flashToast({
          kind: 'success',
          text: t('skillsTab.moveSuccess', {
            defaultValue: 'Moved "{{name}}" to {{scope}}',
            name: skill.name,
            scope: label,
          }) as string,
        });
      } catch (e) {
        if (!isCurrentContext()) return;
        flashToast({ kind: 'error', text: (e as Error).message });
      }
    },
    [
      effectiveProjectPath,
      selectedSkill,
      refresh,
      flashToast,
      setActiveScope,
      setActiveSlug,
      t,
      beforeMutation,
      isCurrentContext,
    ],
  );

  const moveTargets = useMemo((): { label: string; target: MoveTarget }[] => {
    const targets: { label: string; target: MoveTarget }[] = [];
    targets.push({ label: t('skillsTab.userScope'), target: { scope: 'user', projectPath: null } });
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
  }, [projects, t]);

  return (
    <aside className={cn('skills-list', compact && 'w-full')} aria-label={t('skillsTab.listLabel')}>
      <div className="skills-list-controls">
        <label className="skills-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('skillsTab.localSearch')}
            aria-label={t('skillsTab.localSearch')}
          />
          {query ? (
            <button
              type="button"
              className="skills-icon-button"
              onClick={() => setQuery('')}
              aria-label={t('skillsTab.clearSearch')}
            >
              <X size={14} />
            </button>
          ) : null}
        </label>
        <div className="skills-filter-group" aria-label={t('skillsTab.filterLabel')}>
          {(['all', 'user', 'project', 'builtin'] as const).map((scope) => (
            <button
              type="button"
              key={scope}
              aria-pressed={scopeFilter === scope}
              disabled={scope === 'project' && !effectiveProjectPath}
              onClick={() => setScopeFilter(scope)}
            >
              {t(`skillsTab.filter${scope[0].toUpperCase()}${scope.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="skills-list-scroll">
        {loading && !skills ? (
          <div className="skills-empty">
            <Loader2 size={18} className="animate-spin" />
            <p>{t('skillsTab.loading')}</p>
          </div>
        ) : sections.length ? (
          sections.map((section) => (
            <ListSection
              key={section.scope}
              title={section.title}
              items={section.items}
              activeSlug={activeScope === section.scope ? activeSlug : null}
              onSelect={onSelect}
              onDelete={handleDeleteSkill}
              onMove={handleMoveSkill}
              moveTargets={moveTargets}
              currentProjectPath={effectiveProjectPath}
              t={t}
            />
          ))
        ) : (
          <div className="skills-empty">
            <Search size={22} />
            <p>
              {t(
                query.trim()
                  ? 'skillsTab.noMatches'
                  : scopeFilter === 'project'
                    ? 'skillsTab.emptyProject'
                    : scopeFilter === 'user'
                      ? 'skillsTab.emptyGlobal'
                      : 'skillsTab.empty',
              )}
            </p>
            {query.trim() ? (
              <button type="button" className="skills-button" onClick={() => setQuery('')}>
                {t('skillsTab.clearSearch')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </aside>
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
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && menuRef.current?.contains(event.target as Node)) return;
      setCtxMenu(null);
      setShowMoveSubmenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [ctxMenu]);
  const openMenu = (event: React.MouseEvent, skill: Skill) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu({
      skill,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 205)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260)),
    });
    setShowMoveSubmenu(false);
  };
  const targets = moveTargets.filter((target) =>
    ctxMenu?.skill.scope === 'user'
      ? target.target.scope !== 'user'
      : target.target.scope !== 'project' || target.target.projectPath !== currentProjectPath,
  );
  return (
    <section className="skills-section" aria-label={title}>
      <div className="skills-section-label">
        {title}
        <span>{items.length}</span>
      </div>
      <ul>
        {items.map((skill) => (
          <li key={`${skill.scope}:${skill.slug}`} className="relative">
            <button
              type="button"
              className="skills-row"
              aria-current={activeSlug === skill.slug ? 'true' : undefined}
              onClick={() => onSelect(skill)}
              onContextMenu={skill.readonly ? undefined : (event) => openMenu(event, skill)}
            >
              <div className="skills-row-title">
                <span>{skill.name}</span>
                {skill.version ? (
                  <span className="text-[11px] text-muted-foreground">v{skill.version}</span>
                ) : null}
              </div>
              {skill.description ? (
                <p className="skills-row-description line-clamp-2">{skill.description}</p>
              ) : null}
              <div className="skills-row-meta">
                <span>
                  {t(
                    `skillsTab.${skill.scope === 'user' ? 'scopeUser' : skill.scope === 'project' ? 'scopeProject' : 'scopeBuiltin'}`,
                  )}
                  {skill.readonly ? ` · ${t('skillsTab.readOnly')}` : ''}
                </span>
                {skill.overriddenBy ? (
                  <span className="skills-tag">
                    {t('skillsTab.replacedBy', {
                      scope: t(
                        skill.overriddenBy === 'project'
                          ? 'skillsTab.scopeProject'
                          : 'skillsTab.scopeUser',
                      ),
                    })}
                  </span>
                ) : skill.overridesBuiltin ? (
                  <span className="skills-tag skills-tag-accent">{t('skillsTab.override')}</span>
                ) : null}
              </div>
            </button>
            {!skill.readonly ? (
              <button
                type="button"
                className="skills-icon-button skills-row-menu"
                aria-label={t('skillsTab.moreFor', { name: skill.name })}
                aria-haspopup="menu"
                onClick={(event) => openMenu(event, skill)}
              >
                <MoreHorizontal size={16} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {ctxMenu ? (
        <div
          ref={menuRef}
          role="menu"
          className="skills-menu"
          style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
          >
            <ArrowRightLeft size={14} />
            {t('skillsTab.moveTo')}
          </button>
          {showMoveSubmenu ? (
            <div className="max-h-44 overflow-y-auto border-y border-border py-1">
              {targets.map((target) => (
                <button
                  type="button"
                  role="menuitem"
                  key={`${target.target.scope}:${target.target.projectPath}`}
                  onClick={() => {
                    onMove(ctxMenu.skill, target.target);
                    setCtxMenu(null);
                  }}
                >
                  {target.target.scope === 'user' ? <Globe size={14} /> : <Folder size={14} />}
                  {target.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="text-destructive"
            onClick={() => {
              onDelete(ctxMenu.skill);
              setCtxMenu(null);
            }}
          >
            <Trash2 size={14} />
            {t('skillsTab.delete')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function EmptyState({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="skills-empty">
      <span className="skills-empty-symbol">
        <Sparkles size={24} />
      </span>
      <h3>{t('skillsTab.selectTitle')}</h3>
      <p>{t('skillsTab.selectHint')}</p>
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
  editing,
  error,
  readReady,
  onRetry,
  projectPath,
  onUseSkill,
  isDarkMode,
  onSave,
  onDelete,
  onEdit,
  onCreateOverride,
  onCancel,
  t,
}: {
  skill: Skill;
  content: string;
  onChange: (v: string) => void;
  isDirty: boolean;
  loading: boolean;
  saving: boolean;
  editing: boolean;
  error: string | null;
  readReady: boolean;
  onRetry: () => void;
  projectPath: string | null;
  onUseSkill?: () => void;
  isDarkMode: boolean;
  onSave: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onCreateOverride: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [view, setView] = useState<'read' | 'form' | 'source' | 'split'>('read');
  const document = useMemo(() => splitSkillDocument(content), [content]);
  const formAvailable = canEditSkillForm(content);
  const latestContent = useRef(content);
  latestContent.current = content;
  useEffect(
    () => setView(editing ? (canEditSkillForm(latestContent.current) ? 'form' : 'source') : 'read'),
    [skill.skillDir, editing],
  );
  const scopeLabel = t(
    skill.scope === 'user'
      ? 'skillsTab.scopeUser'
      : skill.scope === 'project'
        ? 'skillsTab.scopeProject'
        : 'skillsTab.scopeBuiltin',
  );
  return (
    <section
      className="skills-detail"
      aria-label={t('skillsTab.detailLabel', { name: skill.name })}
    >
      <header className="skills-detail-header">
        <div className="skills-detail-heading">
          <span className="skills-detail-symbol">
            <Sparkles size={20} />
          </span>
          <div>
            <h2>{skill.name}</h2>
            <div className="skills-detail-badges">
              <span className="skills-tag">
                {scopeLabel}
                {skill.readonly ? ` · ${t('skillsTab.readOnly')}` : ''}
              </span>
              {skill.version ? <span className="skills-tag">v{skill.version}</span> : null}
              {skill.overriddenBy ? (
                <span className="skills-tag">
                  {t('skillsTab.replacedBy', {
                    scope: t(
                      skill.overriddenBy === 'project'
                        ? 'skillsTab.scopeProject'
                        : 'skillsTab.scopeUser',
                    ),
                  })}
                </span>
              ) : (
                <span className="skills-tag skills-tag-accent">
                  {t('skillsTab.effectiveVersion')}
                </span>
              )}
            </div>
          </div>
        </div>
        {skill.description ? (
          <p className="skills-detail-description">{skill.description}</p>
        ) : null}
        <div className="skills-detail-actions">
          <div className="skills-view-tabs" aria-label={t('skillsTab.viewLabel')}>
            {(
              [
                ...(editing && formAvailable ? ['form'] : []),
                'read',
                'source',
                ...(editing ? ['split'] : []),
              ] as ('read' | 'form' | 'source' | 'split')[]
            ).map((mode) => (
              <button
                type="button"
                key={mode}
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                {t(mode === 'source' && editing ? 'skillsTab.advancedSource' : `skillsTab.${mode}`)}
              </button>
            ))}
          </div>
          <div className="skills-edit-actions">
            {!editing && onUseSkill ? (
              <button
                type="button"
                className="skills-button skills-button-primary"
                disabled={loading || !readReady || Boolean(skill.overriddenBy)}
                title={skill.overriddenBy ? t('skillsTab.useEffectiveVersion') : undefined}
                onClick={onUseSkill}
              >
                <Sparkles size={15} />
                {t('skillsTab.useInConversation')}
              </button>
            ) : null}
            {editing ? (
              <>
                <button
                  type="button"
                  className="skills-button"
                  disabled={saving}
                  onClick={onCancel}
                >
                  {t('skillsTab.cancel')}
                </button>
                <button
                  type="button"
                  className="skills-button skills-button-primary"
                  disabled={!isDirty || saving}
                  onClick={onSave}
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {t(saving ? 'skillsTab.saving' : 'skillsTab.save')}
                </button>
              </>
            ) : skill.readonly ? (
              <button
                type="button"
                className="skills-button"
                disabled={loading || !readReady}
                onClick={onCreateOverride}
              >
                <Copy size={15} />
                {t('skillsTab.createOverride')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="skills-button"
                  disabled={loading || !readReady}
                  onClick={onEdit}
                >
                  <PencilLine size={15} />
                  {t('skillsTab.edit')}
                </button>
                <button
                  type="button"
                  className="skills-icon-button"
                  onClick={onDelete}
                  aria-label={t('skillsTab.delete')}
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      {error ? (
        <p role="alert" className="skills-inline-error">
          {error}
          {!readReady ? (
            <button type="button" className="skills-button" disabled={loading} onClick={onRetry}>
              <RefreshCw size={14} />
              {t('skillsTab.retry')}
            </button>
          ) : null}
        </p>
      ) : null}
      <div className={cn('skills-detail-content', view === 'split' && 'split')}>
        {loading ? (
          <div className="skills-empty">
            <Loader2 size={20} className="animate-spin" />
            <p>{t('skillsTab.loading')}</p>
          </div>
        ) : !readReady ? null : (
          <>
            {view === 'form' ? (
              <SkillForm
                content={content}
                onChange={onChange}
                disabled={saving}
                isDarkMode={isDarkMode}
              />
            ) : null}
            {view === 'source' || view === 'split' ? (
              <div className="skills-source" aria-label={t('skillsTab.source')}>
                <CodeMirror
                  value={content}
                  onChange={onChange}
                  editable={!skill.readonly && editing && !saving}
                  extensions={[markdown(), EditorView.lineWrapping]}
                  theme={isDarkMode ? zincDarkTheme : zincLightTheme}
                  height="100%"
                  style={{ height: '100%' }}
                  basicSetup={{
                    lineNumbers: editing,
                    foldGutter: editing,
                    highlightActiveLine: editing,
                    indentOnInput: true,
                    autocompletion: false,
                    searchKeymap: true,
                  }}
                />
              </div>
            ) : null}
            {view === 'read' || view === 'split' ? (
              <SkillReader
                key={`${skill.scope}:${skill.slug}:${skill.scope === 'project' ? projectPath : ''}`}
                content={document.body}
                scope={skill.scope}
                slug={skill.slug}
                projectPath={projectPath}
              />
            ) : null}
          </>
        )}
      </div>
      <footer className="skills-detail-footer">
        <details>
          <summary>{t('skillsTab.basicInfo')}</summary>
          <dl className="skills-info">
            <dt>{t('skillsTab.location')}</dt>
            <dd>{skill.skillDir}</dd>
            <dt>{t('skillsTab.file')}</dt>
            <dd>SKILL.md</dd>
            <dt>{t('skillsTab.availability')}</dt>
            <dd>
              {t(
                skill.scope === 'project'
                  ? 'skillsTab.projectAvailability'
                  : 'skillsTab.globalAvailability',
              )}
            </dd>
            {Object.entries(document.metadata).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt>{key}</dt>
                <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
        <span role="status">
          {editing
            ? t(isDirty ? 'skillsTab.unsaved' : 'skillsTab.editing')
            : skill.readonly
              ? t('skillsTab.builtinReadOnly')
              : t(
                  skill.scope === 'project'
                    ? 'skillsTab.projectAvailability'
                    : 'skillsTab.globalAvailability',
                )}
        </span>
      </footer>
    </section>
  );
}

type NewModalCreated = { slug: string; name: string; scope: 'user' | 'project' };

function NewSkillModal({
  onClose,
  onCreated,
  onBatchChanged,
  projectAvailable,
  projectPath,
  t,
}: {
  onClose: () => void;
  onCreated: (created: NewModalCreated) => void;
  onBatchChanged: () => void;
  projectAvailable: boolean;
  projectPath: string | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [tab, setTab] = useState<'install' | 'import' | 'create'>('install');
  const [scope, setScope] = useState<'user' | 'project'>(projectAvailable ? 'project' : 'user');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const confirm = useConfirm();
  const [createDirty, setCreateDirty] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  const [closing, setClosing] = useState(false);
  const dirty = createDirty || importDirty;
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const close = async () => {
    if (busy || closing) return;
    setClosing(true);
    try {
      if (
        dirty &&
        !(await confirm({
          message: t('skillsTab.discardNewSkill'),
          destructive: true,
          confirmLabel: t('confirmDialog.discard'),
        }))
      )
        return;
      onClose();
    } finally {
      setClosing(false);
    }
  };
  useEffect(() => {
    if (!projectAvailable) setScope('user');
  }, [projectAvailable]);
  const shared = {
    projectAvailable,
    projectPath,
    t,
    scope,
    onScopeChange: setScope,
    onBusyChange: setBusy,
  };
  return (
    <SkillDialog
      title={t('skillsTab.newTitle')}
      description={t('skillsTab.addDescription')}
      onClose={close}
      busy={busy || closing}
      suspended={closing}
    >
      <div className="skills-add-tabs" role="tablist" aria-label={t('skillsTab.addMethod')}>
        {(
          [
            { tab: 'install', icon: Download, label: 'tabInstall' },
            { tab: 'import', icon: FolderInput, label: 'tabImport' },
            { tab: 'create', icon: PencilLine, label: 'tabCreate' },
          ] as const
        ).map((item) => (
          <button
            type="button"
            key={item.tab}
            id={`${id}-${item.tab}`}
            role="tab"
            aria-controls={`${id}-${item.tab}-panel`}
            aria-selected={tab === item.tab}
            disabled={busy}
            onClick={() => setTab(item.tab)}
          >
            <item.icon size={15} />
            {t(`skillsTab.${item.label}`)}
          </button>
        ))}
      </div>
      <div className="skills-dialog-body">
        <div
          className="h-full"
          role="tabpanel"
          id={`${id}-install-panel`}
          aria-labelledby={`${id}-install`}
          hidden={tab !== 'install'}
        >
          <InstallFromClawHub {...shared} onInstalled={onCreated} />
        </div>
        <div
          className="h-full"
          role="tabpanel"
          id={`${id}-import-panel`}
          aria-labelledby={`${id}-import`}
          hidden={tab !== 'import'}
        >
          <ImportFromFolder
            {...shared}
            onDirtyChange={setImportDirty}
            onBatchChanged={onBatchChanged}
            onImported={onCreated}
          />
        </div>
        <div
          className="h-full"
          role="tabpanel"
          id={`${id}-create-panel`}
          aria-labelledby={`${id}-create`}
          hidden={tab !== 'create'}
        >
          <CreateFromScratch {...shared} onDirtyChange={setCreateDirty} onCreated={onCreated} />
        </div>
      </div>
    </SkillDialog>
  );
}

function ScopeSelector({
  scope,
  onChange,
  projectAvailable,
  t,
  disabled = false,
}: {
  scope: 'user' | 'project';
  onChange: (s: 'user' | 'project') => void;
  projectAvailable: boolean;
  t: ReturnType<typeof useTranslation>['t'];
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="skills-scope-selector">
      <label htmlFor={id}>{t('skillsTab.scope')}</label>
      <select
        id={id}
        value={projectAvailable ? scope : 'user'}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as 'user' | 'project')}
      >
        <option value="user">{t('skillsTab.installGlobal')}</option>
        {projectAvailable ? <option value="project">{t('skillsTab.installProject')}</option> : null}
      </select>
      <p>
        {t(
          scope === 'project' && projectAvailable
            ? 'skillsTab.projectAvailability'
            : 'skillsTab.globalAvailability',
        )}
      </p>
    </div>
  );
}

function InstallFromClawHub({
  scope,
  onScopeChange,
  onBusyChange,
  projectAvailable,
  projectPath,
  onInstalled,
  t,
}: {
  scope: 'user' | 'project';
  onScopeChange: (scope: 'user' | 'project') => void;
  onBusyChange: (busy: boolean) => void;
  projectAvailable: boolean;
  projectPath: string | null;
  onInstalled: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [preview, setPreview] = useState<{ content: string; version: string | null } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [forceForSlug, setForceForSlug] = useState<string | null>(null);
  const inspectSequence = useRef(0);
  useEffect(() => onBusyChange(installing), [installing, onBusyChange]);
  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setSelected(null);
    setPreview(null);
    setInspecting(false);
    setErrorText(null);
    inspectSequence.current++;
    if (!query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await api<{ results: SearchResult[] }>('/api/skills/clawhub/search', {
          query,
        });
        if (!cancelled) setResults(data.results);
      } catch (error) {
        if (!cancelled) setErrorText((error as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
  const inspect = async (result: SearchResult) => {
    const sequence = ++inspectSequence.current;
    setSelected(result);
    setPreview(null);
    setInspecting(true);
    setErrorText(null);
    setForceForSlug(null);
    try {
      const data = await api<{ content: string; version: string | null }>(
        '/api/skills/clawhub/inspect',
        { slug: result.slug, owner: result.owner },
      );
      if (sequence === inspectSequence.current) setPreview(data);
    } catch (error) {
      if (sequence === inspectSequence.current) setErrorText((error as Error).message);
    } finally {
      if (sequence === inspectSequence.current) setInspecting(false);
    }
  };
  const install = async () => {
    if (!selected || !preview) return;
    setInstalling(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : 'user';
      const result = await api<InstallResponse>('/api/skills/clawhub/install', {
        slug: selected.slug,
        owner: selected.owner,
        version: preview.version,
        scope: effectiveScope,
        projectPath: effectiveScope === 'project' ? projectPath : null,
        force: forceForSlug === `${selected.owner || ''}:${selected.slug}`,
      });
      if (result.installed) {
        onInstalled({
          slug: result.slug,
          name: result.skill?.name || result.slug,
          scope: result.scope,
        });
        return;
      }
      if (result.needsForce) {
        setForceForSlug(`${selected.owner || ''}:${selected.slug}`);
        setErrorText(t('skillsTab.flaggedSuspicious', { slug: selected.slug }));
        return;
      }
      setErrorText(result.stderr || result.stdout || `Install failed (exit ${result.exitCode})`);
    } catch (error) {
      setErrorText((error as Error).message);
    } finally {
      setInstalling(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 py-4">
        <label className="skills-search">
          <Search size={16} />
          <input
            disabled={installing}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('skillsTab.searchPlaceholder')}
            aria-label={t('skillsTab.searchPlaceholder')}
          />
          {searching ? <Loader2 size={15} className="animate-spin" /> : null}
        </label>
      </div>
      {errorText ? (
        <p
          role="alert"
          className="mx-6 mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          {errorText}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {selected ? (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-semibold">{selected.name}</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {selected.owner ? `@${selected.owner}/` : ''}
                  {selected.slug}
                  {preview?.version ? ` · v${preview.version}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="skills-icon-button"
                disabled={installing}
                onClick={() => {
                  inspectSequence.current++;
                  setSelected(null);
                  setPreview(null);
                  setInspecting(false);
                  setErrorText(null);
                }}
                aria-label={t('skillsTab.backToResults')}
              >
                <ArrowLeft size={16} />
              </button>
            </div>
            {inspecting ? (
              <div className="skills-empty">
                <Loader2 size={20} className="animate-spin" />
                <p>{t('skillsTab.inspecting')}</p>
              </div>
            ) : preview ? (
              <SkillMarkdown content={splitSkillDocument(preview.content).body} />
            ) : (
              <button type="button" className="skills-button" onClick={() => inspect(selected)}>
                {t('skillsTab.retry')}
              </button>
            )}
          </>
        ) : results.length ? (
          <ul className="divide-y divide-border">
            {results.map((result) => (
              <li
                key={`${result.owner || ''}:${result.slug}`}
                className="flex items-center justify-between gap-3 py-4"
              >
                <div className="min-w-0">
                  <h3 className="break-words text-[13px] font-medium">{result.name}</h3>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {result.owner ? `@${result.owner}/` : ''}
                    {result.slug}
                  </p>
                </div>
                <button type="button" className="skills-button" onClick={() => inspect(result)}>
                  {t('skillsTab.inspect')}
                </button>
              </li>
            ))}
          </ul>
        ) : searching ? (
          <div className="skills-empty">
            <Loader2 size={20} className="animate-spin" />
            <p>{t('skillsTab.loading')}</p>
          </div>
        ) : (
          <div className="skills-empty h-full">
            <span className="skills-empty-symbol">
              <Search size={24} />
            </span>
            <h3>{t(query.trim() ? 'skillsTab.noResults' : 'skillsTab.searchHint')}</h3>
            {!query.trim() ? (
              <>
                <p>{t('skillsTab.searchHelp')}</p>
                <div className="skills-suggestions">
                  {['slides', 'pdf', 'design'].map((example) => (
                    <button type="button" key={example} onClick={() => setQuery(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
      <footer className="skills-dialog-footer">
        <ScopeSelector
          scope={scope}
          onChange={onScopeChange}
          projectAvailable={projectAvailable}
          t={t}
          disabled={installing}
        />
        <button
          type="button"
          className="skills-button skills-button-primary"
          disabled={!preview || installing || inspecting}
          onClick={install}
        >
          {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {t(
            installing
              ? 'skillsTab.installing'
              : selected && forceForSlug === `${selected.owner || ''}:${selected.slug}`
                ? 'skillsTab.installForce'
                : 'skillsTab.install',
          )}
        </button>
      </footer>
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

type PickedFiles = {
  rootName: string;
  files: File[];
  manifest: { relativePath: string; size: number }[];
  skillMd: string | null;
} | null;

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

function parseFrontmatterFields(content: string): {
  name: string | null;
  description: string | null;
} {
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
  scope,
  onScopeChange: setScope,
  onBusyChange,
  onDirtyChange,
  onBatchChanged,
  projectAvailable,
  projectPath,
  onImported,
  t,
}: {
  scope: 'user' | 'project';
  onScopeChange: (scope: 'user' | 'project') => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBatchChanged: () => void;
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
  useEffect(
    () => onBusyChange(importing || batchImporting),
    [importing, batchImporting, onBusyChange],
  );
  const [batchResults, setBatchResults] = useState<Map<string, BatchResult>>(new Map());
  const [batchDone, setBatchDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  useEffect(
    () => onDirtyChange(!batchDone && Boolean(sourcePath || picked || batchCandidates)),
    [sourcePath, picked, batchCandidates, batchDone, onDirtyChange],
  );

  const batchMode = batchCandidates !== null;

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
    setSlug(cleaned ? cleaned.split('/').filter(Boolean).pop() || '' : '');
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
    validationDebounceRef.current = window.setTimeout(
      async () => {
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
      },
      picked ? 50 : 400,
    );
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
      const stripped =
        rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
      return stripped === 'SKILL.md';
    });

    if (rootSkillFile) {
      // Single skill — existing flow
      const manifest: { relativePath: string; size: number }[] = files.map((f) => {
        const rel = f.webkitRelativePath || f.name;
        const stripped =
          rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
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
      const stripped =
        rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
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
      const r = await api<{
        parentPath: string;
        folders: Array<{
          folderName: string;
          hasSkillMd: boolean;
          name: string | null;
          description: string | null;
          sourcePath: string;
          fileCount: number;
          totalSize: number;
        }>;
      }>('/api/skills/scan', { parentPath: sourcePath.trim() });
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

  const submitBatch = useCallback(
    async (retryFailed = false) => {
      if (!batchCandidates || selectedCount === 0) return;
      setBatchImporting(true);
      setBatchDone(false);
      const selected = batchCandidates.filter(
        (c) =>
          c.hasSkillMd &&
          selectedFolders.has(c.folderName) &&
          (!retryFailed || batchResults.get(c.folderName)?.status === 'error'),
      );

      const results = retryFailed ? new Map(batchResults) : new Map<string, BatchResult>();
      for (const c of selected) {
        results.set(c.folderName, { folderName: c.folderName, status: 'pending' });
      }
      setBatchResults(new Map(results));

      for (const candidate of selected) {
        results.set(candidate.folderName, {
          folderName: candidate.folderName,
          status: 'importing',
        });
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
            if (effectiveScope === 'project' && projectPath)
              formData.append('projectPath', projectPath);
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
          results.set(candidate.folderName, {
            folderName: candidate.folderName,
            status: 'success',
          });
        } catch (e) {
          results.set(candidate.folderName, {
            folderName: candidate.folderName,
            status: 'error',
            error: (e as Error).message,
          });
        }
        setBatchResults(new Map(results));
      }

      setBatchImporting(false);
      setBatchDone(true);

      onBatchChanged();
    },
    [
      batchCandidates,
      selectedCount,
      selectedFolders,
      projectAvailable,
      scope,
      projectPath,
      mode,
      force,
      batchParentName,
      onBatchChanged,
      batchResults,
    ],
  );

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
        if (effectiveScope === 'project' && projectPath)
          formData.append('projectPath', projectPath);
        if (force) formData.append('force', 'true');

        const r = await authenticatedFetch('/api/skills/import-upload', {
          method: 'POST',
          body: formData,
        });
        const data = await r.json().catch(() => ({}) as Record<string, unknown>);
        if (!r.ok) {
          if (data.validation) setValidation(data.validation as ValidationResult);
          throw new Error((data as { error?: string }).error || `Upload failed (${r.status})`);
        }
        const result = data as { slug: string; scope: 'user' | 'project'; skill: Skill | null };
        onImported({
          slug: result.slug,
          name: result.skill?.name || result.slug,
          scope: result.scope,
        });
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
        setErrorText(
          msg +
            ' ' +
            t('skillsTab.importEnableForce', { defaultValue: 'Enable "Overwrite" to replace it.' }),
        );
      } else {
        setErrorText(msg);
      }
    } finally {
      setImporting(false);
    }
  }, [
    canSubmit,
    picked,
    sourcePath,
    slug,
    projectAvailable,
    scope,
    projectPath,
    mode,
    force,
    onImported,
    t,
  ]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Source: pick or paste */}
        <Field
          label={t('skillsTab.importSource', { defaultValue: 'Source folder' })}
          hint={
            !batchMode
              ? (t('skillsTab.importSourceHintBoth', {
                  defaultValue:
                    'Pick a folder via the native dialog, or paste an absolute path. ~ is expanded server-side.',
                }) as string)
              : undefined
          }
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
                !sourcePath.trim() || scanning || batchMode
                  ? 'cursor-not-allowed border-neutral-100 text-neutral-400 dark:border-neutral-900 dark:text-neutral-600'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900',
              )}
            >
              {scanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <FolderSearch className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              <span>
                {scanning
                  ? t('skillsTab.scanning', { defaultValue: 'Scanning…' })
                  : t('skillsTab.scan', { defaultValue: 'Scan' })}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              // @ts-expect-error webkitdirectory is non-standard but supported in Chromium/WebKit/Firefox.
              webkitdirectory=""
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
                picked || batchMode
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
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                {batchParentName}
              </span>
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
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800"
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
                      current: Array.from(batchResults.values()).filter(
                        (r) => r.status === 'success' || r.status === 'error',
                      ).length,
                      total: selectedCount,
                    })}
                  </div>
                )}
                {batchDone && (
                  <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] font-medium dark:border-neutral-900">
                    {t('skillsTab.batchComplete', {
                      defaultValue:
                        'Batch import complete: {{success}} succeeded, {{failed}} failed',
                      success: Array.from(batchResults.values()).filter(
                        (r) => r.status === 'success',
                      ).length,
                      failed: Array.from(batchResults.values()).filter((r) => r.status === 'error')
                        .length,
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
                            {result.status === 'success' && (
                              <CheckCircle2
                                className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500"
                                strokeWidth={1.75}
                              />
                            )}
                            {result.status === 'error' && (
                              <XCircle
                                className="h-3.5 w-3.5 text-red-600 dark:text-red-500"
                                strokeWidth={1.75}
                              />
                            )}
                            {result.status === 'importing' && (
                              <Loader2
                                className="h-3.5 w-3.5 animate-spin text-neutral-400"
                                strokeWidth={1.75}
                              />
                            )}
                            {result.status === 'pending' && <div className="h-3.5 w-3.5" />}
                          </span>
                        ) : !isSkill ? (
                          <div className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : null}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Folder
                              className={cn(
                                'h-3 w-3 shrink-0',
                                isSkill
                                  ? 'text-amber-500'
                                  : 'text-neutral-300 dark:text-neutral-700',
                              )}
                              strokeWidth={1.75}
                            />
                            <span
                              className={cn(
                                'truncate text-[12px]',
                                isSkill ? 'font-medium' : 'text-neutral-400 dark:text-neutral-600',
                              )}
                            >
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
                              {candidate.name && (
                                <span className="font-medium">{candidate.name}</span>
                              )}
                              {candidate.name && candidate.description && <span> — </span>}
                              {candidate.description && <span>{candidate.description}</span>}
                            </div>
                          )}
                          {isSkill && (
                            <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                              {candidate.fileCount}{' '}
                              {t('skillsTab.files', { defaultValue: 'files' })} ·{' '}
                              {formatBytes(candidate.totalSize)}
                            </div>
                          )}
                          {result?.status === 'error' && result.error && (
                            <div className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400">
                              {result.error}
                            </div>
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
                  <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                      disabled={batchImporting}
                    />
                    <span>
                      {t('skillsTab.importForce', { defaultValue: 'Overwrite if exists' })}
                    </span>
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
              hint={
                t('skillsTab.importSlugHint', {
                  defaultValue: 'Defaults to the source folder name. Edit to override.',
                }) as string
              }
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

            <details className="skills-advanced">
              <summary>{t('skillsTab.advancedOptions')}</summary>
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
                      <span className="font-medium">
                        {t('skillsTab.importModeCopy', { defaultValue: 'Copy' })}
                      </span>
                      <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                        {t('skillsTab.importModeCopyHint', {
                          defaultValue: '— independent copy, edits live in the skills folder.',
                        })}
                      </span>
                    </span>
                  </label>
                  <label
                    className={cn(
                      'flex items-start gap-2',
                      picked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                    )}
                  >
                    <input
                      type="radio"
                      name="import-mode"
                      checked={mode === 'symlink'}
                      disabled={picked !== null}
                      onChange={() => setMode('symlink')}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">
                        {t('skillsTab.importModeSymlink', { defaultValue: 'Symlink' })}
                      </span>
                      <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                        {picked
                          ? t('skillsTab.symlinkUnavailable', {
                              defaultValue:
                                '— unavailable for picker uploads (no source path on disk).',
                            })
                          : t('skillsTab.importModeSymlinkHint', {
                              defaultValue:
                                '— edits in the source folder propagate live; deleting the source breaks the skill.',
                            })}
                      </span>
                    </span>
                  </label>
                </div>
              </Field>
              <label className="mt-3 flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
                {t('skillsTab.importForce')}
              </label>
            </details>

            <ValidationPanel result={validation} validating={validating} t={t} />
          </>
        )}

        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="skills-dialog-footer">
        <ScopeSelector
          scope={scope}
          onChange={setScope}
          projectAvailable={projectAvailable}
          t={t}
          disabled={importing || batchImporting || batchDone}
        />
        {batchMode ? (
          batchDone ? (
            <div className="flex items-center gap-2">
              {Array.from(batchResults.values()).some((result) => result.status === 'error') ? (
                <button
                  type="button"
                  className="skills-button"
                  disabled={batchImporting}
                  onClick={() => void submitBatch(true)}
                >
                  <RefreshCw size={14} />
                  {t('skillsTab.retryFailed')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const first = batchCandidates?.find(
                    (candidate) => batchResults.get(candidate.folderName)?.status === 'success',
                  );
                  onImported({
                    slug: first?.folderName ?? '',
                    name: first?.name || first?.folderName || '',
                    scope,
                  });
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t('skillsTab.batchDone', { defaultValue: 'Done' })}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void submitBatch()}
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
                  : t('skillsTab.importNSkills', {
                      defaultValue: 'Import {{count}} skills',
                      count: selectedCount,
                    })}
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
          <Loader2
            className="ml-auto h-3.5 w-3.5 animate-spin text-neutral-400"
            strokeWidth={1.75}
          />
        ) : result?.ok ? (
          <CheckCircle2
            className="ml-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500"
            strokeWidth={1.75}
          />
        ) : (
          <XCircle
            className="ml-auto h-3.5 w-3.5 text-red-600 dark:text-red-500"
            strokeWidth={1.75}
          />
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[12px]">
        {result?.stats ? (
          <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
            <span>
              {result.stats.fileCount} {t('skillsTab.files', { defaultValue: 'files' })}
            </span>
            <span>·</span>
            <span>{formatBytes(result.stats.totalBytes)}</span>
            {result.frontmatter && (result.frontmatter as { name?: string }).name ? (
              <>
                <span>·</span>
                <span className="truncate">
                  name:{' '}
                  <span className="font-mono">{(result.frontmatter as { name: string }).name}</span>
                </span>
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
              <li
                key={`w${i}`}
                className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
              >
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
  scope,
  onScopeChange: setScope,
  onBusyChange,
  onDirtyChange,
  projectAvailable,
  projectPath,
  onCreated,
  t,
}: {
  scope: 'user' | 'project';
  onScopeChange: (scope: 'user' | 'project') => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  projectAvailable: boolean;
  projectPath: string | null;
  onCreated: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [initialBody] = useState(t('skillsTab.bodyTemplate'));
  const [body, setBody] = useState(initialBody);
  useEffect(
    () => onDirtyChange(Boolean(slug || name || description || body !== initialBody)),
    [slug, name, description, body, initialBody, onDirtyChange],
  );
  const [creating, setCreating] = useState(false);
  useEffect(() => onBusyChange(creating), [creating, onBusyChange]);
  const [errorText, setErrorText] = useState<string | null>(null);

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
          <Field
            label={t('skillsTab.fieldSlug', { defaultValue: 'Slug' })}
            hint={t('skillsTab.slugHint', { defaultValue: 'Folder name, e.g. my-skill' }) as string}
          >
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
              placeholder={
                slug ||
                (t('skillsTab.fieldNamePlaceholder', {
                  defaultValue: 'Optional, defaults to slug',
                }) as string)
              }
              className="h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-[13px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            />
          </Field>
        </div>
        <Field
          label={t('skillsTab.fieldDescription', { defaultValue: 'Description' })}
          hint={
            t('skillsTab.descHint', {
              defaultValue:
                'Shown in the slash menu — describe what this skill does and when to invoke it.',
            }) as string
          }
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
          />
        </Field>
        <Field
          label={t('skillsTab.fieldBody', { defaultValue: 'Initial body (Markdown)' })}
          hint={
            t('skillsTab.bodyHint', {
              defaultValue: 'Optional. Edit in detail later from the main view.',
            }) as string
          }
        >
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-[12px] outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600"
            placeholder={'# My Skill\n\nDescribe what this skill does...'}
          />
        </Field>

        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <div className="skills-dialog-footer">
        <ScopeSelector
          scope={scope}
          onChange={setScope}
          projectAvailable={projectAvailable}
          t={t}
          disabled={creating}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit || creating}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          <span>
            {creating
              ? t('skillsTab.creating', { defaultValue: 'Creating…' })
              : t('skillsTab.create', { defaultValue: 'Create skill' })}
          </span>
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
  const id = useId();
  const input =
    isValidElement(children) && (children.type === 'input' || children.type === 'textarea');
  return (
    <div className="mt-3">
      <label
        htmlFor={input ? id : undefined}
        className="mb-1 block text-[12px] font-medium text-neutral-700 dark:text-neutral-300"
      >
        {label}
      </label>
      {input ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children}
      {hint ? <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
    </div>
  );
}
