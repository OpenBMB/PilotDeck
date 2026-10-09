import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

type Item = { label: string; icon: LucideIcon; onSelect: () => void };

// Render outside the virtualized message: content-visibility on a message
// clips menus that extend beyond its measured height.
export default function FileActionsMenu({ label, items }: { label: string; items: Item[] }) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); setPosition(null); trigger.current?.focus({ preventScroll: true });
    };
    const dismiss = () => setPosition(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);
  const toggle = () => {
    if (position) { setPosition(null); return; }
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const height = items.length * 32 + 8;
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 192, bounds.right - 184)),
      top: Math.max(8, bounds.bottom + height + 8 > window.innerHeight ? bounds.top - height - 6 : bounds.bottom + 6) });
  };
  return <>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={toggle} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 opacity-100 hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 sm:opacity-0 sm:group-hover/turn-file:opacity-100 sm:group-focus-within/turn-file:opacity-100 dark:hover:bg-neutral-800"><MoreHorizontal className="h-4 w-4" /></button>
    {position && createPortal(<div ref={menu} role="menu" aria-label={label} style={{ ...position, width: 184 }} className="fixed z-[100] rounded-lg border border-neutral-200 bg-white p-1 text-neutral-700 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200" onKeyDown={event => {
      if (event.key === 'Tab') { setPosition(null); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menu.current?.querySelectorAll('button') ?? []);
      const current = buttons.findIndex(button => button === document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }}>{items.map(({ label: itemLabel, icon: Icon, onSelect }) => <button key={itemLabel} role="menuitem" type="button" onClick={event => { event.stopPropagation(); setPosition(null); trigger.current?.focus({ preventScroll: true }); onSelect(); }} className="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded px-2.5 text-left text-xs hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none dark:hover:bg-neutral-800 dark:focus:bg-neutral-800"><Icon className="h-3.5 w-3.5 shrink-0" />{itemLabel}</button>)}</div>, document.body)}
  </>;
}
