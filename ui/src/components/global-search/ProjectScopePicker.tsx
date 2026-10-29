import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Folder, FolderOpen, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { projectDisplayName } from '../../lib/customNames';
import type { Project } from '../../types/app';

export default function ProjectScopePicker({ projects, value, onChange }: {
  projects: Project[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('common');
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const typeahead = useRef({ text: '', updatedAt: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const options = [{ value: '', label: t('globalSearch.allProjects') }, ...projects.map(project => ({
    value: project.name, label: projectDisplayName(project),
  }))];
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selectedLabel = options.find(option => option.value === value)?.label || value || options[0].label;

  useEffect(() => {
    if (!open) return;
    const button = optionButtons.current[Math.min(activeIndex, options.length - 1)];
    button?.focus();
    button?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const show = () => {
    setActiveIndex(selectedIndex);
    typeahead.current = { text: '', updatedAt: 0 };
    setOpen(true);
  };
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };
  const handleMenuKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab') {
      const dialog = root.current?.closest('[role="dialog"]');
      const candidates = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])
        .filter(element => element.tabIndex >= 0 && !root.current?.contains(element) && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
      const adjacent = candidates.filter(element => {
        const position = trigger.current?.compareDocumentPosition(element) || 0;
        return Boolean(position & (event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING));
      });
      const next = event.shiftKey ? adjacent.at(-1) || candidates.at(-1) : adjacent[0] || candidates[0];
      event.preventDefault(); event.stopPropagation();
      setOpen(false); next?.focus();
      return;
    }
    const last = options.length - 1;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown') setActiveIndex(index => (index + 1) % options.length);
      else if (event.key === 'ArrowUp') setActiveIndex(index => (index + last) % options.length);
      else if (event.key === 'Home') setActiveIndex(0);
      else if (event.key === 'End') setActiveIndex(last);
      else choose(options[Math.min(activeIndex, last)].value);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - typeahead.current.updatedAt < 650 ? typeahead.current.text : '') + event.key.toLocaleLowerCase();
      typeahead.current = { text, updatedAt: now };
      const start = text.length === 1 ? activeIndex + 1 : activeIndex;
      const matches = (query: string) => Array.from({ length: options.length }, (_, offset) => (start + offset) % options.length)
        .find(index => options[index].label.toLocaleLowerCase().startsWith(query));
      const next = matches(text) ?? matches(event.key.toLocaleLowerCase());
      if (next !== undefined) setActiveIndex(next);
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return <div ref={root} className="global-search-project-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key !== 'Escape' || !open || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    setOpen(false); trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" className="global-search-project-trigger" data-scoped={Boolean(value)}
      aria-label={t('globalSearch.scope') + ': ' + selectedLabel} title={selectedLabel}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) setOpen(false); else show(); }} onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault(); event.stopPropagation(); show();
      }}>
      <FolderOpen size={14} strokeWidth={1.7} aria-hidden />
      <span>{selectedLabel}</span>
      <ChevronDown size={13} strokeWidth={1.7} aria-hidden />
    </button>
    {open ? <div id={id} className="global-search-project-menu" role="listbox" aria-label={t('globalSearch.scope')}
      onKeyDown={handleMenuKey}>
      <div className="global-search-project-menu-heading" role="presentation">{t('globalSearch.scope')}</div>
      {options.map((option, index) => {
        const Icon = option.value ? Folder : Layers;
        return <button key={option.value} ref={element => { optionButtons.current[index] = element; }} type="button" role="option"
          aria-selected={value === option.value} tabIndex={activeIndex === index ? 0 : -1} title={option.label}
          className="global-search-project-option" onFocus={() => setActiveIndex(index)} onClick={() => choose(option.value)}>
          <Icon size={14} strokeWidth={1.6} aria-hidden /><span>{option.label}</span>
          {value === option.value ? <Check size={14} strokeWidth={1.8} aria-hidden /> : <span aria-hidden />}
        </button>;
      })}
    </div> : null}
  </div>;
}
