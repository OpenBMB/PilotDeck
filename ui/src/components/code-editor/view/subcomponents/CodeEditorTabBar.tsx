import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../../../lib/utils.js';
import { getFileIconData } from '../../../file-tree/constants/fileIcons';
import type { CodeEditorFile, CodeEditorTab } from '../../types/types';

type TabMenuState = {
  tabId: string;
  x: number;
  y: number;
};

type CodeEditorTabBarProps = {
  tabs: CodeEditorTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseTabs: (tabIds: string[]) => void;
  reserveToolbarSpace?: boolean;
  labels: {
    tabList: string;
    closeTab: (fileName: string) => string;
    moreActions: string;
    closeCurrent: string;
    closeOthers: string;
    closeToRight: string;
    closeAll: string;
    modified: string;
  };
};

const MENU_WIDTH = 196;
const MENU_ESTIMATED_HEIGHT = 164;
const MENU_VIEWPORT_MARGIN = 8;

const getTabFile = (tab: CodeEditorTab): CodeEditorFile | null => (
  tab.fileStack.at(-1) ?? null
);

export default function CodeEditorTabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onCloseTabs,
  reserveToolbarSpace = false,
  labels,
}: CodeEditorTabBarProps) {
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);

  useEffect(() => {
    tabButtonRefs.current.get(activeTabId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId]);

  useEffect(() => {
    if (!menu) return undefined;

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    const closeMenu = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) {
        return;
      }
      setMenu(null);
    };
    const closeMenuOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        const targetTabId = menu.tabId;
        setMenu(null);
        window.requestAnimationFrame(() => tabButtonRefs.current.get(targetTabId)?.focus());
      }
    };
    const closeMenuWithoutEvent = () => setMenu(null);

    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeMenuOnEscape);
    window.addEventListener('resize', closeMenuWithoutEvent);
    window.addEventListener('scroll', closeMenuWithoutEvent, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeMenuOnEscape);
      window.removeEventListener('resize', closeMenuWithoutEvent);
      window.removeEventListener('scroll', closeMenuWithoutEvent, true);
    };
  }, [menu]);

  useEffect(() => {
    if (menu && !tabs.some((tab) => tab.id === menu.tabId)) {
      setMenu(null);
    }
  }, [menu, tabs]);

  const openMenu = (tabId: string, x: number, y: number) => {
    setMenu({
      tabId,
      x: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(x, window.innerWidth - MENU_WIDTH - MENU_VIEWPORT_MARGIN),
      ),
      y: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(y, window.innerHeight - MENU_ESTIMATED_HEIGHT - MENU_VIEWPORT_MARGIN),
      ),
    });
  };

  const openMenuForTab = (tabId: string, event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    openMenu(tabId, event.clientX, event.clientY);
  };

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
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(tabs[index].id, rect.left, rect.bottom + 4);
    }
  };

  const closeTabs = (action: 'current' | 'others' | 'right' | 'all') => {
    if (!menu) return;
    const targetIndex = tabs.findIndex((tab) => tab.id === menu.tabId);
    if (targetIndex === -1) return;

    const tabIds = action === 'current'
      ? [menu.tabId]
      : action === 'others'
        ? tabs.filter((tab) => tab.id !== menu.tabId).map((tab) => tab.id)
        : action === 'right'
          ? tabs.slice(targetIndex + 1).map((tab) => tab.id)
          : tabs.map((tab) => tab.id);

    setMenu(null);
    if (tabIds.length === 1) onClose(tabIds[0]);
    else if (tabIds.length > 1) onCloseTabs(tabIds);
  };

  const menuTargetIndex = menu ? tabs.findIndex((tab) => tab.id === menu.tabId) : -1;
  const menuContent = menu ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={labels.moreActions}
      onKeyDown={(event) => {
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ),
        );
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        let nextIndex: number | null = null;
        if (event.key === 'ArrowDown') {
          nextIndex = (currentIndex + 1) % items.length;
        } else if (event.key === 'ArrowUp') {
          nextIndex = (currentIndex - 1 + items.length) % items.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = items.length - 1;
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          const targetTabId = menu.tabId;
          setMenu(null);
          if (event.key === 'Escape') {
            event.preventDefault();
            window.requestAnimationFrame(() => tabButtonRefs.current.get(targetTabId)?.focus());
          }
          return;
        }

        if (nextIndex !== null && items.length > 0) {
          event.preventDefault();
          items[nextIndex]?.focus();
        }
      }}
      className="fixed z-[120] w-[196px] rounded-lg border border-neutral-200 bg-white p-1.5 text-[12px] text-neutral-700 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => closeTabs('current')}
        className="flex h-8 w-full items-center rounded-md px-2.5 text-left outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
      >
        {labels.closeCurrent}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={tabs.length <= 1}
        onClick={() => closeTabs('others')}
        className="flex h-8 w-full items-center rounded-md px-2.5 text-left outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800 dark:disabled:text-neutral-600"
      >
        {labels.closeOthers}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={menuTargetIndex < 0 || menuTargetIndex >= tabs.length - 1}
        onClick={() => closeTabs('right')}
        className="flex h-8 w-full items-center rounded-md px-2.5 text-left outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800 dark:disabled:text-neutral-600"
      >
        {labels.closeToRight}
      </button>
      <div
        role="separator"
        className="my-1 border-t border-neutral-200 dark:border-neutral-700"
      />
      <button
        type="button"
        role="menuitem"
        onClick={() => closeTabs('all')}
        className="flex h-8 w-full items-center rounded-md px-2.5 text-left outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
      >
        {labels.closeAll}
      </button>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div className="relative h-10 min-w-0 flex-shrink-0">
        <div
          role="tablist"
          aria-label={labels.tabList}
          className={cn(
            'scrollbar-hide flex h-10 min-w-0 items-end gap-0.5 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-2 pt-1 dark:border-neutral-800 dark:bg-neutral-900/70',
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
                onContextMenu={(event) => openMenuForTab(tab.id, event)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onClose(tab.id);
                  }
                }}
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
      </div>
      {menuContent}
    </>
  );
}
