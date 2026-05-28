import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  ChevronRight,
  FolderGit2,
  LayoutGrid,
  Pin,
  Sparkles,
  User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../../lib/utils.js';

type CommandMenuCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

type CommandMenuProps = {
  commands?: CommandMenuCommand[];
  selectedIndex?: number;
  onSelect?: (command: CommandMenuCommand, index: number, isHover: boolean) => void;
  onClose: () => void;
  position?: { top: number; left: number; bottom?: number };
  isOpen?: boolean;
  frequentCommands?: CommandMenuCommand[];
};

// Lucide icons replace the legacy ASCII namespace tags ([B]/[P]/[U]/[O]/[*]).
// Match the V2 stroke-light look used elsewhere in the shell so the menu reads
// as part of the same design language as the breadcrumb/tab strip/composer.
const namespaceIcons: Record<string, LucideIcon> = {
  pinned: Pin,
  frequent: Sparkles,
  builtin: Box,
  project: FolderGit2,
  user: User,
  other: LayoutGrid,
};

const getCommandKey = (command: CommandMenuCommand) =>
  `${command.name}::${command.namespace || command.type || 'other'}::${command.path || ''}`;

const getNamespace = (command: CommandMenuCommand) =>
  command.namespace || command.type || 'other';

// Anchor the menu to the textarea: above on desktop, full-bleed bottom sheet on
// mobile. Returns inline styles so we can mix calculated coords with Tailwind
// classes for visual treatment.
const getMenuPosition = (position: { top: number; left: number; bottom?: number }): CSSProperties => {
  if (typeof window === 'undefined') {
    return { position: 'fixed', top: '16px', left: '16px' };
  }
  if (window.innerWidth < 640) {
    return {
      position: 'fixed',
      bottom: `${position.bottom ?? 90}px`,
      left: '16px',
      right: '16px',
      maxHeight: 'min(50vh, 320px)',
    };
  }
  return {
    position: 'fixed',
    top: `${Math.max(16, Math.min(position.top, window.innerHeight - 336))}px`,
    left: `${position.left}px`,
    width: 'min(420px, calc(100vw - 32px))',
    maxHeight: '320px',
  };
};

export default function CommandMenu({
  commands = [],
  selectedIndex = -1,
  onSelect,
  onClose,
  position = { top: 0, left: 0 },
  isOpen = false,
  frequentCommands = [],
}: CommandMenuProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItemRef = useRef<HTMLDivElement | null>(null);
  const menuPosition = getMenuPosition(position);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current || !(event.target instanceof Node)) {
        return;
      }
      if (!menuRef.current.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!selectedItemRef.current || !menuRef.current) {
      return;
    }
    const menuRect = menuRef.current.getBoundingClientRect();
    const itemRect = selectedItemRef.current.getBoundingClientRect();
    if (itemRect.bottom > menuRect.bottom || itemRect.top < menuRect.top) {
      selectedItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  if (!isOpen) {
    return null;
  }

  const containerClass = cn(
    'overflow-y-auto rounded-lg border bg-white shadow-lg',
    'border-neutral-200 dark:border-neutral-800 dark:bg-neutral-900',
  );

  if (commands.length === 0) {
    return (
      <div
        ref={menuRef}
        className={cn(containerClass, 'px-4 py-5 text-center text-[13px] text-neutral-500 dark:text-neutral-400')}
        style={{ ...menuPosition, zIndex: 1000 }}
      >
        {t('commandMenu.empty', { defaultValue: 'No commands available' })}
      </div>
    );
  }

  const hasFrequentCommands = frequentCommands.length > 0;
  const frequentCommandKeys = new Set(frequentCommands.map(getCommandKey));
  const groupedCommands = commands.reduce<Record<string, CommandMenuCommand[]>>((groups, command) => {
    if (hasFrequentCommands && frequentCommandKeys.has(getCommandKey(command))) {
      return groups;
    }
    const namespace = getNamespace(command);
    if (!groups[namespace]) {
      groups[namespace] = [];
    }
    groups[namespace].push(command);
    return groups;
  }, {});
  if (hasFrequentCommands) {
    groupedCommands.frequent = frequentCommands;
  }

  const preferredOrder = hasFrequentCommands
    ? ['pinned', 'frequent', 'builtin', 'project', 'user', 'other']
    : ['pinned', 'builtin', 'project', 'user', 'other'];
  const extraNamespaces = Object.keys(groupedCommands).filter(
    (namespace) => !preferredOrder.includes(namespace),
  );
  const orderedNamespaces = [...preferredOrder, ...extraNamespaces].filter(
    (namespace) => groupedCommands[namespace],
  );

  const commandIndexByKey = new Map<string, number>();
  commands.forEach((command, index) => {
    const key = getCommandKey(command);
    if (!commandIndexByKey.has(key)) {
      commandIndexByKey.set(key, index);
    }
  });

  const showGroupHeaders = orderedNamespaces.length > 1;

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Available commands"
      className={cn(containerClass, 'p-1')}
      style={{ ...menuPosition, zIndex: 1000 }}
    >
      {orderedNamespaces.map((namespace, groupIdx) => {
        const Icon = namespaceIcons[namespace] || namespaceIcons.other;
        return (
          <div
            key={namespace}
            className={cn(
              'pb-1',
              groupIdx > 0 && showGroupHeaders && 'mt-1 border-t border-neutral-100 pt-2 dark:border-neutral-800',
            )}
          >
            {showGroupHeaders ? (
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t(`commandMenu.groups.${namespace}`, {
                  defaultValue: namespace.charAt(0).toUpperCase() + namespace.slice(1),
                })}
              </div>
            ) : null}

            {(groupedCommands[namespace] || []).map((command) => {
              const commandKey = getCommandKey(command);
              const commandIndex = commandIndexByKey.get(commandKey) ?? -1;
              const isSelected = commandIndex === selectedIndex;
              return (
                <div
                  key={`${namespace}-${command.name}-${command.path || ''}`}
                  ref={isSelected ? selectedItemRef : null}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    'group relative flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors',
                    isSelected
                      ? 'bg-neutral-100 dark:bg-neutral-800'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                  )}
                  onMouseEnter={() =>
                    onSelect && commandIndex >= 0 && onSelect(command, commandIndex, true)
                  }
                  onClick={() =>
                    onSelect && commandIndex >= 0 && onSelect(command, commandIndex, false)
                  }
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <Icon
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400"
                    strokeWidth={1.75}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                        {command.name}
                      </span>
                      {command.metadata?.type ? (
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {command.metadata.type}
                        </span>
                      ) : null}
                    </div>
                    {command.description ? (
                      <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
                        {command.description}
                      </div>
                    ) : null}
                  </div>
                  {isSelected ? (
                    <ChevronRight
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500"
                      strokeWidth={2}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
