import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function SkillDialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  small = false,
  suspended = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  small?: boolean;
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const latest = useRef({ busy, onClose, suspended });
  latest.current = { busy, onClose, suspended };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (latest.current.suspended) return;
      if (event.key === 'Escape' && !latest.current.busy) {
        event.preventDefault();
        latest.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]',
        ) ?? [],
      ).filter((el) => el.getClientRects().length);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="skills-workbench skills-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        data-dialog-surface
        className={`skills-dialog${small ? ' skills-dialog-small' : ''}`}
      >
        <header className="skills-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            ref={close}
            type="button"
            className="skills-icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label={t('skillsTab.close')}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
