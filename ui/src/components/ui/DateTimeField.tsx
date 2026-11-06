import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFloatingPanel } from './useFloatingPanel';

export function localDateValue(date: Date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseLocalDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(12, 0, 0, 0);
  return localDateValue(date) === value ? date : null;
}
export function calendarDays(month: Date) {
  const first = new Date(month); first.setDate(1);
  first.setDate(1 - (first.getDay() + 6) % 7);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first); date.setDate(first.getDate() + index); return date;
  });
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max'> & {
  type: 'date' | 'time'; value: string; onValueChange: (value: string) => void;
  min?: string; max?: string;
};

/** Keep typed input/validation; the calendar and clock panels use app chrome. */
export default function DateTimeField({ type, value, onValueChange, min, max, disabled, className, ...props }: Props) {
  const { t, i18n } = useTranslation('common');
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const locked = disabled || props.readOnly;
  const close = () => setOpen(false);
  const { panelRef, style } = useFloatingPanel(open, anchor, close, { side: 'below', width: 288, maxHeight: 380, focusRef: trigger });
  const initialDate = () => {
    const candidate = value || localDateValue(new Date());
    return parseLocalDate(min && candidate < min ? min : max && candidate > max ? max : candidate) ?? new Date();
  };
  const [day, setDay] = useState(initialDate);
  const [time, setTime] = useState(value || '09:00');
  const returnFocus = () => { close(); trigger.current?.focus(); };
  const commit = (next: string) => { if (locked) return; if (next !== value) onValueChange(next); returnFocus(); };
  const label = t(type === 'date' ? 'formControls.chooseDate' : 'formControls.chooseTime');
  const validDay = (date: Date) => {
    const next = localDateValue(date);
    return date.getFullYear() > 0 && date.getFullYear() <= 9999 && (!min || next >= min) && (!max || next <= max);
  };
  const moveMonth = (offset: number) => {
    const next = new Date(day); const date = next.getDate();
    next.setDate(1); next.setMonth(next.getMonth() + offset);
    const end = new Date(next); end.setMonth(end.getMonth() + 1); end.setDate(0);
    next.setDate(Math.min(date, end.getDate()));
    const bounded = min && localDateValue(next) < min ? parseLocalDate(min) : max && localDateValue(next) > max ? parseLocalDate(max) : next;
    if (bounded && validDay(bounded)) setDay(bounded);
  };
  const moveDay = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -(day.getDay() + 6) % 7, End: 6 - (day.getDay() + 6) % 7 };
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); moveMonth(event.key === 'PageUp' ? -1 : 1); }
    else if (event.key in offsets) {
      event.preventDefault(); const next = new Date(day); next.setDate(day.getDate() + offsets[event.key]);
      if (validDay(next)) setDay(next);
    }
  };
  useEffect(() => { if (locked) close(); }, [locked]);
  useEffect(() => {
    if (!open || style.visibility === 'hidden') return;
    panelRef.current?.querySelector<HTMLElement>(type === 'date' ? '[data-day-focus="true"]' : 'select')?.focus();
  }, [open, day, type, panelRef, style.visibility]);
  // Escape belongs to this layer; the anchor is not itself focusable.
  const handlePanelKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); returnFocus(); }
    if (event.key === 'Tab') {
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), select:not(:disabled)') ?? []);
      const end = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === end) { event.preventDefault(); returnFocus(); }
    }
  };
  const locale = i18n?.resolvedLanguage || i18n?.language || 'en';
  const days = type === 'date' && open ? calendarDays(day) : [];
  return <span ref={anchor} className="pd-datetime-field">
    <input {...props} type={type} value={value} min={min} max={max} disabled={disabled} className={className}
      onChange={event => onValueChange(event.target.value)}
      onKeyDown={event => {
        props.onKeyDown?.(event);
        if (!event.defaultPrevented && !locked && (event.key === 'F4' || event.altKey && event.key === 'ArrowDown')) {
          event.preventDefault(); setDay(initialDate()); setTime(value || '09:00'); setOpen(true);
        }
      }} />
    <button ref={trigger} type="button" className="pd-datetime-trigger" disabled={locked} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={event => { event.preventDefault(); setDay(initialDate()); setTime(value || '09:00'); setOpen(!open); }}>
      {type === 'date' ? <CalendarDays size={16} /> : <Clock3 size={16} />}
    </button>
    {open && createPortal(<div ref={panelRef} id={id} role="dialog" aria-label={label} className="pd-date-panel" style={style} onKeyDown={handlePanelKey}>
      {type === 'date' ? <>
        <div className="pd-calendar-heading">
          <button type="button" aria-label={t('formControls.previousMonth')} onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button>
          <strong aria-live="polite">{day.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</strong>
          <button type="button" aria-label={t('formControls.nextMonth')} onClick={() => moveMonth(1)}><ChevronRight size={16} /></button>
        </div>
        <table role="grid" aria-label={label} className="pd-calendar-grid">
          <thead><tr>{days.slice(0, 7).map(date => <th key={date.getDay()} scope="col">{date.toLocaleDateString(locale, { weekday: 'short' })}</th>)}</tr></thead>
          <tbody>{Array.from({ length: 6 }, (_, row) => <tr key={row}>{days.slice(row * 7, row * 7 + 7).map(date => {
            const iso = localDateValue(date); const focused = iso === localDateValue(day);
            return <td key={iso} aria-selected={iso === value}><button type="button" disabled={!validDay(date)} data-day-focus={focused} tabIndex={focused ? 0 : -1}
              data-outside={date.getMonth() !== day.getMonth()} data-selected={iso === value} aria-current={iso === localDateValue(new Date()) ? 'date' : undefined}
              aria-label={date.toLocaleDateString(locale, { dateStyle: 'full' })} onKeyDown={moveDay} onClick={() => commit(iso)}>{date.getDate()}</button></td>;
          })}</tr>)}</tbody>
        </table>
      </> : <div className="pd-clock-fields">
        <label>{t('formControls.hour')}<select aria-label={t('formControls.hour')} value={time.slice(0, 2)} onChange={event => setTime(`${event.target.value}:${time.slice(3, 5)}`)}>{Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(n => <option key={n}>{n}</option>)}</select></label>
        <span aria-hidden="true">:</span>
        <label>{t('formControls.minute')}<select aria-label={t('formControls.minute')} value={time.slice(3, 5)} onChange={event => setTime(`${time.slice(0, 2)}:${event.target.value}`)}>{Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map(n => <option key={n}>{n}</option>)}</select></label>
      </div>}
      <div className="pd-date-actions">
        <button type="button" onClick={() => commit('')}>{t('formControls.clear')}</button>
        {type === 'date'
          ? <button type="button" disabled={!validDay(new Date())} onClick={() => commit(localDateValue(new Date()))}>{t('formControls.today')}</button>
          : <button type="button" disabled={Boolean(min && time < min || max && time > max)} onClick={() => commit(time)}>{t('formControls.apply')}</button>}
      </div>
    </div>, document.body)}
  </span>;
}
