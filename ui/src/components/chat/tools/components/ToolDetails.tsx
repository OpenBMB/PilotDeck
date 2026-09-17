import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyTextToClipboard } from '../../../../utils/clipboard';

export function ToolDetails({ title, copyContent, copyLabel, children, footer }: {
  title: ReactNode; copyContent?: string; copyLabel?: string; children: ReactNode; footer?: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => setCopied(false), [copyContent]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || full) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, full]);
  return (
    <section className="tool-details min-w-0 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      <header className="flex min-w-0 items-center justify-between gap-3 px-3.5 py-2 text-xs text-neutral-500 dark:text-neutral-400">
        <div className="min-w-0 truncate">{title}</div>
        <div className="flex shrink-0 items-center gap-3">
          {(overflows || full) && <button type="button" onClick={() => setFull(!full)} aria-expanded={full} className="hover:text-violet-600 dark:hover:text-violet-400">{t(full ? 'toolDisplay.collapse' : 'toolDisplay.full')}</button>}
          {copyContent != null && <button type="button" aria-label={copyLabel || t('toolDisplay.copy')} title={copyLabel || t('toolDisplay.copy')} className="rounded p-1 hover:text-violet-600 focus-visible:outline-violet-500 dark:hover:text-violet-400" onClick={async () => { if (await copyTextToClipboard(copyContent)) setCopied(true); }}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>}
        </div>
      </header>
      <div ref={viewport} role="region" tabIndex={0} aria-label={t('toolDisplay.details')} className={`overflow-auto overscroll-contain px-3.5 pb-3 text-[12px] leading-5 focus-visible:outline-violet-500 ${full ? '' : 'max-h-80'}`}>
        {children}
      </div>
      {footer && <footer className="flex justify-end gap-2 px-3.5 pb-2.5 text-xs text-neutral-500 dark:text-neutral-400">{footer}</footer>}
    </section>
  );
}
