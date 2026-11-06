import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayText } from '../toolPresentation';
import { needsLargeChangePreview } from '../fileChangePreview';
import { ToolDetails } from './ToolDetails';

type DiffLine = { type: string; content: string; lineNum: number };
interface ToolDiffViewerProps {
  oldContent: unknown; newContent: unknown; filePath: unknown;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileClick?: () => void; badge?: string; badgeColor?: 'gray' | 'green';
}

export const ToolDiffViewer = ({ oldContent, newContent, filePath, createDiff, onFileClick, badge }: ToolDiffViewerProps) => {
  const { t } = useTranslation('chat');
  const oldText = displayText(oldContent);
  const newText = displayText(newContent);
  const path = displayText(filePath);
  // A write may replace an existing file. Without its old contents, show a
  // neutral content preview instead of claiming that every line was added.
  const large = needsLargeChangePreview(oldText, newText);
  const contentPreview = badge === 'Write' || badge === 'New' || oldContent === undefined || large;
  const [preview, setPreview] = useState({ source: newText, limit: 200 });
  if (preview.source !== newText) setPreview({ source: newText, limit: 200 });
  const limit = preview.source === newText ? preview.limit : 200;
  const contentLines = useMemo(() => contentPreview ? newText.split('\n') : [], [contentPreview, newText]);
  const diff = useMemo(() => contentPreview ? [] : createDiff(oldText, newText), [contentPreview, newText, oldText, createDiff]);
  const total = contentPreview ? contentLines.length : diff.length;
  const lines = contentPreview ? contentLines.slice(0, limit).map((content, index) => ({ type: 'context', content, lineNum: index + 1 })) : diff.slice(0, limit);
  const added = diff.filter(line => line.type === 'added').length;
  const removed = diff.filter(line => line.type === 'removed').length;
  return (
    <ToolDetails title={<span className="inline-flex max-w-full items-center gap-3">
      {onFileClick ? <button type="button" title={path} onClick={onFileClick} className="truncate hover:text-[var(--pd-accent-strong,#7c3aed)] hover:underline dark:hover:text-[var(--pd-accent-strong,#a78bfa)]">{path}</button> : <span className="truncate">{path}</span>}
      <span className="shrink-0">{contentPreview ? t('toolDisplay.fileContent') : t('toolDisplay.changes')}</span>
      {!contentPreview && <span className="shrink-0 tabular-nums"><span className="text-green-600 dark:text-green-400">+{added}</span>{' '}<span className="text-red-500 dark:text-red-400">−{removed}</span></span>}
    </span>} copyContent={contentPreview ? newText : diff.map(line => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}${line.content}`).join('\n')}
      footer={total > 200 ? <div className="flex w-full items-center justify-between gap-3">
        <span>{t('toolDisplay.previewLines', { count: Math.min(limit, total), total })}</span>
        {limit < total && <button type="button" className="hover-brand-text" onClick={() => setPreview({ source: newText, limit: limit + 200 })}>{t('toolDisplay.moreLines')}</button>}
      </div> : undefined}>
      {large && badge !== 'Write' && badge !== 'New' && <p className="mb-2 text-muted-foreground">{t('toolDisplay.largeChangePreview')}</p>}
      {lines.some(line => line.content.length > 2000) && <p className="mb-2 text-muted-foreground">{t('toolDisplay.longLinePreview')}</p>}
      {lines.length === 0 ? <span>{t('toolDisplay.noChanges')}</span> : <div className="w-max min-w-full font-mono text-xs leading-5">
        {lines.map((line, index) => <div key={index} data-file-preview-line className={`flex ${line.type === 'added' ? 'bg-green-500/10' : line.type === 'removed' ? 'bg-red-500/10' : ''}`}>
          <span className="w-10 shrink-0 select-none pr-3 text-right text-neutral-400 dark:text-neutral-500">{line.lineNum}</span>
          {!contentPreview && <span className={`w-5 shrink-0 select-none ${line.type === 'added' ? 'text-green-600 dark:text-green-400' : line.type === 'removed' ? 'text-red-500 dark:text-red-400' : ''}`}>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span>}
          <span className="whitespace-pre pr-3">{line.content.length > 2000 ? `${line.content.slice(0, 2000)}…` : line.content || ' '}</span>
        </div>)}
      </div>}
    </ToolDetails>
  );
};
