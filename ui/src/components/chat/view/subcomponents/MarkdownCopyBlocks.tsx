import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import { Check, Copy, AlertCircle, FileCode2, Code2, WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { copyHtmlToClipboard, copyTextToClipboard } from '../../../../utils/clipboard';

export const MarkdownSourceContext = createContext('');

function CopyButton({ label, onCopy, markdown = false }: {
  label: string;
  onCopy: () => Promise<boolean>;
  markdown?: boolean;
}) {
  const { t } = useTranslation('chat');
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  const title = status === 'copied'
    ? t('copyBlock.copied', { defaultValue: 'Copied' })
    : status === 'failed'
      ? t('copyBlock.failed', { defaultValue: 'Copy failed. Try again.' }) : label;
  const Icon = status === 'copied' ? Check : status === 'failed' ? AlertCircle : markdown ? FileCode2 : Copy;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={pending}
      className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 dark:hover:bg-white/10"
      onClick={async () => {
        setPending(true);
        let copied = false;
        try { copied = await onCopy(); } catch { /* Show failure without interrupting chat. */ }
        if (mounted.current) {
          setPending(false);
          setStatus(copied ? 'copied' : 'failed');
        }
      }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

export function MarkdownCodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const { t } = useTranslation('chat');
  const [wrap, setWrap] = useState(true);
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  // remark adds one display newline to code.value. Remove only that newline,
  // never trim user indentation, blank lines, or literal backslash sequences.
  const text = code?.type === 'element'
    ? code.children.map((child) => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '')
    : '';
  const languageClasses = code?.type === 'element' ? code.properties.className : [];
  const language = (Array.isArray(languageClasses) ? languageClasses : [])
    .map(String).find(value => value.startsWith('language-'))?.slice('language-'.length);
  const languageLabel = language || t('copyBlock.plainText', { defaultValue: 'Plain text' });
  const wrapLabel = t('copyBlock.wrap', { defaultValue: 'Wrap code' });
  return (
    <div className="markdown-code-block not-prose my-4 min-w-0 overflow-hidden rounded-xl border" data-wrap={wrap}>
      <div className="markdown-code-header flex min-w-0 items-center justify-between gap-3 px-4 py-2.5 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate" title={languageLabel}>{languageLabel}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" title={wrapLabel} aria-label={wrapLabel} aria-pressed={wrap}
            onClick={() => setWrap(value => !value)}
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:hover:bg-white/10">
            <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <CopyButton label={t('copyBlock.code', { defaultValue: 'Copy code' })} onCopy={() => copyTextToClipboard(text)} />
        </div>
      </div>
      <pre {...props} className={`${props.className || ''} !m-0 overflow-x-auto`}>
        {children}
      </pre>
    </div>
  );
}

function tableClipboardContent(table: HTMLTableElement) {
  const clone = table.cloneNode(true) as HTMLTableElement;
  // KaTeX includes both MathML and visual text. Copy each formula just once.
  clone.querySelectorAll('.katex').forEach((formula) => {
    formula.replaceWith(formula.querySelector('annotation')?.textContent || formula.textContent || '');
  });
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  const quoteCell = (value: string) => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const text = Array.from(clone.rows, (row) => Array.from(row.cells, (cell) => quoteCell(cell.textContent || '')).join('\t')).join('\n');
  return { text, html: clone.outerHTML };
}

export function MarkdownTable({ node, children, ...props }: ComponentProps<'table'> & ExtraProps) {
  const { t } = useTranslation('chat');
  const source = useContext(MarkdownSourceContext);
  const ref = useRef<HTMLTableElement>(null);
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  // Positions begin at the first cell, but later source lines can still include
  // surrounding blockquote/list indentation. Copy a standalone table.
  const containerWidth = (node?.position?.start.column ?? 1) - 1;
  const markdown = start !== undefined && end !== undefined
    ? source.slice(start, end).replace(/\n([ \t>]*)/g, (_match, prefix: string) => `\n${prefix.slice(containerWidth)}`)
    : '';
  return (
    <div className="markdown-copy-block relative my-4 min-w-0">
      <div className="markdown-copy-controls not-prose absolute right-1 top-1 z-10 flex rounded bg-white text-gray-500 dark:bg-gray-900 dark:text-gray-400">
        <CopyButton label={t('copyBlock.table', { defaultValue: 'Copy table' })} onCopy={() => {
          if (!ref.current) return Promise.resolve(false);
          const { text, html } = tableClipboardContent(ref.current);
          return copyHtmlToClipboard(html, text);
        }} />
        <CopyButton markdown label={t('copyBlock.tableMarkdown', { defaultValue: 'Copy table as Markdown' })} onCopy={() => copyTextToClipboard(markdown)} />
      </div>
      <div className="overflow-x-auto">
        <table {...props} ref={ref} className={`markdown-copy-table ${props.className || ''} !my-0`}>{children}</table>
      </div>
    </div>
  );
}
