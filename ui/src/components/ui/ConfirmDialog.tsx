import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';

export type ConfirmOptions = {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
};

type ConfirmDialogProps = Omit<ConfirmOptions, 'message'> & {
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ title, children, confirmLabel, destructive = false, busy = false, disabled = false, error, onCancel, onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onCancel();
      }
      if (event.key === 'Tab') {
        const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []);
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (!panel.current?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={busy}
        className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl">
        <header className="flex items-start gap-3 px-5 pb-3 pt-5">
          <h2 id={titleId} className="min-w-0 flex-1 break-words text-base font-semibold">{title || t('confirmDialog.title')}</h2>
          <button type="button" disabled={busy} onClick={onCancel} aria-label={t('confirmDialog.close')} className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"><X className="h-4 w-4" /></button>
        </header>
        <div id={bodyId} className="min-h-0 overflow-y-auto break-words px-5 pb-5 text-sm text-muted-foreground">
          {children}
          {error && <p role="alert" className="mt-3 rounded-md bg-destructive/10 p-3 text-destructive">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button ref={cancel} type="button" disabled={busy} onClick={onCancel} className="h-9 shrink-0 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50">{t('confirmDialog.cancel')}</button>
          <button type="button" disabled={busy || disabled} onClick={onConfirm} className={`inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-[#5b5ce2] text-white enabled:hover:bg-[#4948cf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b5ce2] focus-visible:ring-offset-2 focus-visible:ring-offset-background'}`}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? t('confirmDialog.working') : confirmLabel || t('confirmDialog.confirm')}
          </button>
        </footer>
      </section>
    </div>, document.body,
  );
}

type Request = { options: ConfirmOptions; owner: symbol; resolve: (confirmed: boolean) => void };
type ConfirmContextValue = { request: (options: ConfirmOptions, owner: symbol) => Promise<boolean>; cancel: (owner: symbol) => void };
const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const pending = useRef<Request | null>(null);
  const [requestState, setRequest] = useState<Request | null>(null);
  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(confirmed);
  }, []);
  const request = useCallback((options: ConfirmOptions, owner: symbol) => {
    // A second click must never approve or replace the pending operation.
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const current = { options, owner, resolve };
      pending.current = current;
      setRequest(current);
    });
  }, []);
  const cancel = useCallback((owner: symbol) => {
    if (pending.current?.owner === owner) settle(false);
  }, [settle]);
  useEffect(() => () => { pending.current?.resolve(false); pending.current = null; }, []);
  return <ConfirmContext.Provider value={{ request, cancel }}>
    {children}
    {requestState && <ConfirmDialog {...requestState.options} onCancel={() => settle(false)} onConfirm={() => settle(true)}>{requestState.options.message}</ConfirmDialog>}
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  const owner = useRef(Symbol('confirmation'));
  const mounted = useRef(true);
  const cancel = context?.cancel;
  useEffect(() => {
    const identity = owner.current;
    mounted.current = true;
    return () => { mounted.current = false; cancel?.(identity); };
  }, [cancel]);
  const request = context?.request;
  return useCallback((options: ConfirmOptions) => {
    if (!mounted.current) return Promise.resolve(false);
    if (!request) throw new Error('Confirmation requires ConfirmProvider');
    return request(options, owner.current);
  }, [request]);
}
