import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';

type CommandMenuCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: { type?: string; [key: string]: unknown };
  matches?: Array<{ field: string; start: number; end: number }>;
  [key: string]: unknown;
};

type CommandMenuProps = {
  commands?: CommandMenuCommand[];
  selectedIndex?: number;
  onSelect?: (command: CommandMenuCommand, index: number, isHover: boolean) => void;
  onClose: () => void;
  position?: { top: number; left: number; bottom?: number; width?: number };
  isOpen?: boolean;
  frequentCommands?: CommandMenuCommand[];
  query?: string;
  selectedCommands?: CommandMenuCommand[];
};

const getCommandKey = (command: CommandMenuCommand) =>
  `${command.name}::${command.namespace || command.type || 'other'}::${command.path || ''}`;

const getMenuPosition = (position: {
  top: number;
  left: number;
  bottom?: number;
  width?: number;
}): CSSProperties => {
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
    bottom: `${position.bottom ?? Math.max(16, window.innerHeight - position.top)}px`,
    left: `${Math.max(8, position.left - 10)}px`,
    width: `${Math.min(position.width ? position.width + 20 : 720, window.innerWidth - 16)}px`,
    maxHeight: '330px',
  };
};

function renderHighlightedText(
  text: string,
  field: string,
  matches: CommandMenuCommand['matches'],
  query: string,
): ReactNode {
  let ranges = (matches || [])
    .filter((match) => match.field === field)
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(text.length, start)),
      end: Math.max(0, Math.min(text.length, end)),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start);

  if (ranges.length === 0 && query) {
    const lowerText = text.toLocaleLowerCase();
    const lowerQuery = query.toLocaleLowerCase();
    ranges = [];
    let from = 0;
    while (from <= lowerText.length - lowerQuery.length) {
      const start = lowerText.indexOf(lowerQuery, from);
      if (start < 0) break;
      ranges.push({ start, end: start + query.length });
      from = start + Math.max(1, query.length);
    }
  }
  if (ranges.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(({ start, end }, index) => {
    if (start < cursor) return;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={`${start}-${end}-${index}`}
        className="rounded-[3px] bg-[#e6e1ff] px-0.5 py-px font-[750] text-[#4e46b7]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export default function CommandMenu({
  commands = [],
  selectedIndex = -1,
  onSelect,
  onClose,
  position = { top: 0, left: 0 },
  isOpen = false,
  query = '',
  selectedCommands = [],
}: CommandMenuProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedItemRef = useRef<HTMLDivElement | null>(null);
  const menuPosition = getMenuPosition(position);
  const selectedCommandNames = new Set(selectedCommands.map((command) => command.name));

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

  return (
    <div
      ref={menuRef}
      className="flex flex-col overflow-hidden rounded-[14px] border border-violet-200 bg-white p-2 text-left font-sans tracking-normal shadow-xl shadow-violet-950/10 [font-synthesis:none] dark:border-violet-900/70 dark:bg-neutral-900"
      style={{ ...menuPosition, zIndex: 1000 }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-2 pb-2 pt-1">
        <strong className="text-[13px] font-bold text-[#343640] dark:text-neutral-100">
          {t('commandMenu.title', { defaultValue: '命令' })}
        </strong>
        <span className="truncate text-[11px] text-[#777987] dark:text-neutral-400">
          {query
            ? `${t('commandMenu.search', { defaultValue: '搜索' })} “${query}” · ${commands.length} 项`
            : `${commands.length} 项`}
        </span>
      </div>
      <div
        role="listbox"
        aria-label={t('commandMenu.ariaLabel', { defaultValue: '可用命令' }) as string}
        className="grid min-h-0 flex-1 gap-0.5 overflow-y-auto [scrollbar-color:#cbc9d5_transparent] [scrollbar-width:thin]"
      >
        {commands.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-neutral-400">
            {t('commandMenu.empty', { defaultValue: '没有匹配的命令' })}
          </div>
        ) : commands.map((command, commandIndex) => {
          const isSelected = commandIndex === selectedIndex;
          const isActive = selectedCommandNames.has(command.name);
          const badge = String(command.metadata?.type || command.type || '')
            .replace('built-in', 'builtin');
          return (
            <div
              key={getCommandKey(command)}
              ref={isSelected ? selectedItemRef : null}
              role="option"
              aria-selected={isActive}
              className={cn(
                'group relative grid min-h-[58px] cursor-pointer grid-cols-[minmax(0,1fr)_14px] items-center gap-2 rounded-[10px] px-3 py-2 text-[#343640] transition-colors hover:bg-[#f7f6ff] hover:text-[#373390] dark:text-neutral-200 dark:hover:bg-violet-950/40 dark:hover:text-violet-200',
                isSelected || isActive
                  ? 'bg-[#eeecff] font-[650] text-[#393393] hover:bg-[#eeecff] dark:bg-violet-950/70 dark:text-violet-200 dark:hover:bg-violet-950/70'
                  : '',
              )}
              onMouseEnter={() => onSelect?.(command, commandIndex, true)}
              onClick={() => onSelect?.(command, commandIndex, false)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-inherit">
                    {renderHighlightedText(command.name, 'name', command.matches, query)}
                  </span>
                  {badge ? (
                    <span className="shrink-0 rounded-md bg-[#f1f0f4] px-2 py-0.5 text-[10px] font-medium text-[#777987] dark:bg-neutral-800 dark:text-neutral-400">
                      {badge}
                    </span>
                  ) : null}
                </div>
                {command.description ? (
                  <div className="mt-1 truncate text-[11px] font-normal text-[#9294a0] dark:text-neutral-400">
                    {renderHighlightedText(command.description, 'description', command.matches, query)}
                  </div>
                ) : null}
              </div>
              {isSelected ? (
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-[#aaa7c2] dark:text-neutral-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
