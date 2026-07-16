import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../../lib/utils.js';
import { getFileIconData } from '../../../file-tree/constants/fileIcons';
import type { CodeEditorFile, CodeEditorTab } from '../../types/types';

type CodeEditorTabBarProps = {
  tabs: CodeEditorTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  reserveToolbarSpace?: boolean;
  labels: {
    tabList: string;
    closeTab: (fileName: string) => string;
    modified: string;
  };
};

const getTabFile = (tab: CodeEditorTab): CodeEditorFile | null => (
  tab.fileStack.at(-1) ?? null
);

export default function CodeEditorTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  reserveToolbarSpace = false,
  labels,
}: CodeEditorTabBarProps) {
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId]);

  const focusTabAt = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onSelect(tab.id);
    window.requestAnimationFrame(() => tabButtonRefs.current.get(tab.id)?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTabAt((index + 1) % tabs.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTabAt((index - 1 + tabs.length) % tabs.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTabAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTabAt(tabs.length - 1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onClose(tabs[index].id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={labels.tabList}
      className={cn(
        'scrollbar-hide flex h-10 min-w-0 flex-shrink-0 items-end gap-0.5 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-2 pt-1 dark:border-neutral-800 dark:bg-neutral-900/70',
        reserveToolbarSpace && 'pr-32',
      )}
    >
      {tabs.map((tab, index) => {
        const file = getTabFile(tab);
        if (!file) return null;
        const active = tab.id === activeTabId;
        const iconData = getFileIconData(file.name);
        const Icon = iconData.icon;

        return (
          <div
            key={tab.id}
            className={cn(
              'group/tab flex h-8 min-w-[9rem] max-w-[14rem] shrink-0 items-center rounded-t-md border border-b-0 transition-colors',
              active
                ? 'border-neutral-200 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100'
                : 'border-transparent text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
            )}
            title={file.path}
          >
            <button
              ref={(element) => {
                if (element) tabButtonRefs.current.set(tab.id, element);
                else tabButtonRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`code-editor-tab-${tab.id}`}
              aria-controls={`code-editor-panel-${tab.id}`}
              aria-selected={active}
              aria-label={`${file.name} — ${file.path}`}
              tabIndex={active ? 0 : -1}
              title={file.path}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', iconData.color)} strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{file.name}</span>
              {tab.dirty ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
                  aria-label={labels.modified}
                />
              ) : null}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              className={cn(
                'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 outline-none transition-colors hover:bg-neutral-200 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
                !active && 'opacity-0 group-hover/tab:opacity-100 focus:opacity-100',
              )}
              title={labels.closeTab(file.name)}
              aria-label={labels.closeTab(file.name)}
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
