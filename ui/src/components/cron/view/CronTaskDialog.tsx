import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function CronTaskDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation('alwaysOn');
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (panel.current?.querySelector<HTMLElement>('input, textarea') || panel.current?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('.pd-date-panel'))) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!latest.current.busy) latest.current.onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]') || []]
        .filter(element => !element.closest('details:not([open]) > :not(summary)'));
      const first = controls[0]; const last = controls.at(-1);
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="cron-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={panel} className="cron-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy} data-dialog-surface>
      <header className="cron-dialog-header"><h2 id={id}>{title}</h2><button type="button" className="cron-icon-button" disabled={busy} onClick={onClose} aria-label={t('cron.workspace.closeEditor', { defaultValue: 'Close task editor' })}><X size={18} /></button></header>
      {children}
    </section>
  </div>, document.body);
}
