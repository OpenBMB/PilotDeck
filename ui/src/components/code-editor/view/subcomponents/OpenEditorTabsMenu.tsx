import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useFloatingPanel } from '../../../ui/useFloatingPanel';
import { FileTypeIcon } from '../../../file-tree/components/FileTypeIcon';
import type { CodeEditorTab } from '../../types/types';

type OpenEditorTabsMenuProps = {
  tabs: CodeEditorTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  label: string;
  modifiedLabel: string;
};

export default function OpenEditorTabsMenu({
  tabs,
  activeTabId,
  onSelect,
  label,
  modifiedLabel,
}: OpenEditorTabsMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { panelRef, style } = useFloatingPanel(open, triggerRef, () => setOpen(false), {
    width: 320,
    maxHeight: 360,
    side: 'below',
  });

  useLayoutEffect(() => {
    if (!open || style.visibility === 'hidden') return;
    const selected = panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest' });
  }, [open, panelRef, style.visibility]);

  return (
    <div className="flex shrink-0 items-center border-b border-neutral-200 bg-neutral-50 px-1 dark:border-neutral-800 dark:bg-neutral-900/70">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 outline-none transition-colors hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      {open ? createPortal(
        <div
          ref={panelRef}
          id={id}
          role="menu"
          aria-label={label}
          style={{ ...style, zIndex: 120 }}
          className="overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1.5 text-[12px] text-neutral-700 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number | undefined;
            if (event.key === 'ArrowDown') next = (current + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else if (event.key === 'Tab') setOpen(false);
            if (next !== undefined) {
              event.preventDefault();
              items[next]?.focus();
            }
          }}
        >
          {tabs.map((tab) => {
            const file = tab.fileStack.at(-1);
            if (!file) return null;
            return (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={tab.id === activeTabId}
                title={file.path}
                onClick={() => {
                  setOpen(false);
                  onSelect(tab.id);
                  window.requestAnimationFrame(() => document.getElementById(`code-editor-tab-${tab.id}`)?.focus({ preventScroll: true }));
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
              >
                <FileTypeIcon filename={file.name} className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{file.name}</span>
                  <span className="block truncate text-[11px] text-neutral-400">{file.path}</span>
                </span>
                {tab.dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" aria-label={modifiedLabel} /> : null}
                {tab.id === activeTabId ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
