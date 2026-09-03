import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Folder, Plus, Search, X } from 'lucide-react';
import type { Project } from '../../types/app';
import { isGeneralProject, compareProjectsBySidebarOrder } from '../app-shell/appShellSelection';
import { projectDisplayName } from '../../lib/customNames';
import { cn } from '../../lib/utils.js';

const WORKSPACE_PICKER_LIST_PREFERRED_MAX = 128;
const WORKSPACE_PICKER_PREFERRED_MAX_HEIGHT = 264;

export type WorkspacePickerBarProps = {
  projects: Project[];
  selectedProject: Project | null;
  forceOpen?: boolean;
  onForceOpenConsumed?: () => void;
  onSelectProject: (project: Project) => void;
  onSelectNone: () => void;
  onCreateProject: () => void;
};

export default function WorkspacePickerBar({
  projects,
  selectedProject,
  forceOpen = false,
  onForceOpenConsumed,
  onSelectProject,
  onSelectNone,
  onCreateProject,
}: WorkspacePickerBarProps) {
  const { t } = useTranslation('chat');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const [listMaxHeight, setListMaxHeight] = useState<number | null>(null);

  const isNoneSelected = Boolean(selectedProject && isGeneralProject(selectedProject));
  const isProjectSelected = Boolean(selectedProject && !isNoneSelected);
  const selectedLabel = isNoneSelected
    ? t('workspacePicker.workWithoutProject', { defaultValue: '不在项目中工作' })
    : isProjectSelected
      ? projectDisplayName(selectedProject as Project)
      : t('workspacePicker.select', { defaultValue: '选择工作空间' });

  const workspaceProjects = useMemo(() => {
    const remaining = projects.filter((project) => !isGeneralProject(project));
    const selectedName = selectedProject && !isGeneralProject(selectedProject)
      ? selectedProject.name
      : null;
    if (selectedName && !remaining.some((project) => project.name === selectedName)) {
      remaining.unshift(selectedProject as Project);
    }
    return remaining.sort(compareProjectsBySidebarOrder);
  }, [projects, selectedProject]);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaceProjects;
    return workspaceProjects.filter((project) => {
      const label = projectDisplayName(project).toLowerCase();
      return label.includes(needle) || project.name.toLowerCase().includes(needle);
    });
  }, [query, workspaceProjects]);

  useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    onForceOpenConsumed?.();
  }, [forceOpen, onForceOpenConsumed]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('keydown', handleKey);
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);

    return () => {
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('keydown', handleKey);
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuMaxHeight(null);
      setListMaxHeight(null);
      return undefined;
    }

    const updateMenuHeight = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const main = document.querySelector('.app-main');
      const pageBottom = Math.min(
        window.innerHeight,
        main instanceof HTMLElement ? main.getBoundingClientRect().bottom : window.innerHeight,
      );
      const available = Math.floor(pageBottom - menu.getBoundingClientRect().top - 8);
      const panelMax = Math.min(WORKSPACE_PICKER_PREFERRED_MAX_HEIGHT, Math.max(1, available));
      const search = menu.querySelector('[data-workspace-picker-search]');
      const footer = menu.querySelector('[data-workspace-picker-footer]');
      const chrome =
        (search instanceof HTMLElement ? search.offsetHeight : 0)
        + (footer instanceof HTMLElement ? footer.offsetHeight : 0);
      setMenuMaxHeight(panelMax);
      setListMaxHeight(Math.min(
        WORKSPACE_PICKER_LIST_PREFERRED_MAX,
        Math.max(48, panelMax - chrome),
      ));
    };

    updateMenuHeight();
    window.addEventListener('resize', updateMenuHeight);
    return () => window.removeEventListener('resize', updateMenuHeight);
  }, [open, filteredProjects.length]);

  return (
    <div ref={rootRef} className="relative z-0 mx-auto w-[calc(100%-36px)]">
      <div
        className={cn(
          '-mt-1.5 flex items-center rounded-b-xl bg-[#f5f6f8] px-2 pb-2.5 pt-4',
          'dark:bg-neutral-800/50',
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((previous) => !previous)}
          className={cn(
            'inline-flex max-w-[70%] items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[13px] leading-none',
            'bg-[#eceef2] text-neutral-700 transition-colors hover:bg-[#e2e4ea]',
            'dark:bg-neutral-700/80 dark:text-neutral-200 dark:hover:bg-neutral-600',
            !selectedProject && 'text-neutral-500 dark:text-neutral-400',
          )}
        >
          {isNoneSelected ? (
            <X className="h-3.5 w-3.5 shrink-0 text-neutral-500" strokeWidth={1.8} />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500" strokeWidth={1.8} />
          )}
          <span className="min-w-0 truncate">{selectedLabel}</span>
        </button>
      </div>

      {open ? (
        <div
          ref={menuRef}
          role="listbox"
          style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}
          className="absolute left-0 top-full z-50 mt-1 flex w-[min(100%,280px)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-neutral-950/10 dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div
            data-workspace-picker-search
            className="shrink-0 border-b border-neutral-200 px-2.5 py-2 dark:border-neutral-800"
          >
            <label className="flex h-8 items-center gap-2 rounded-lg bg-neutral-100 px-2.5 dark:bg-neutral-800">
              <Search className="h-3.5 w-3.5 shrink-0 text-neutral-400" strokeWidth={1.8} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workspacePicker.search', { defaultValue: '搜索项目' }) as string}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
              />
            </label>
          </div>

          <div
            className={cn(
              'min-h-0 overflow-y-auto',
              '[scrollbar-width:thin] [scrollbar-color:#c1c1c1_transparent]',
              '[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5',
              '[&::-webkit-scrollbar-button]:h-0 [&::-webkit-scrollbar-button]:w-0',
              '[&::-webkit-scrollbar-track]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#c1c1c1]',
            )}
            style={listMaxHeight ? { maxHeight: `${listMaxHeight}px` } : { maxHeight: `${WORKSPACE_PICKER_LIST_PREFERRED_MAX}px` }}
          >
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-neutral-400">
                {t('workspacePicker.empty', { defaultValue: '未找到匹配的项目' })}
              </div>
            ) : (
              filteredProjects.map((project) => {
                const selected = selectedProject?.name === project.name && !isNoneSelected;
                return (
                  <button
                    key={project.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSelectProject(project);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] text-neutral-700',
                      'hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
                      selected && 'bg-neutral-100 dark:bg-neutral-800',
                    )}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate">{projectDisplayName(project)}</span>
                    {selected ? <Check className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={2} /> : null}
                  </button>
                );
              })
            )}
          </div>

          <div
            data-workspace-picker-footer
            className="shrink-0 border-t border-neutral-200 py-1 dark:border-neutral-800"
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateProject();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <Plus className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.8} />
              <span>{t('workspacePicker.newProject', { defaultValue: '新建项目' })}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onSelectNone();
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
                isNoneSelected && 'bg-neutral-100 dark:bg-neutral-800',
              )}
            >
              <X className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.8} />
              <span className="min-w-0 flex-1 truncate">
                {t('workspacePicker.workWithoutProject', { defaultValue: '不在项目中工作' })}
              </span>
              {isNoneSelected ? <Check className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={2} /> : null}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
