import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ToolDetails } from './ToolDetails';
import { displayText } from '../toolPresentation';

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
  const contentPreview = badge === 'Write' || badge === 'New' || oldContent === undefined;
  const lines = useMemo(() => contentPreview
    ? newText.split('\n').map((content, index) => ({ type: 'context', content, lineNum: index + 1 }))
    : createDiff(oldText, newText), [contentPreview, newText, oldText, createDiff]);
  const added = lines.filter(line => line.type === 'added').length;
  const removed = lines.filter(line => line.type === 'removed').length;
  return (
    <ToolDetails title={<span className="inline-flex max-w-full items-center gap-3">
      {onFileClick ? <button type="button" title={path} onClick={onFileClick} className="truncate hover:text-violet-600 hover:underline dark:hover:text-violet-400">{path}</button> : <span className="truncate">{path}</span>}
      <span className="shrink-0">{contentPreview ? t('toolDisplay.fileContent') : t('toolDisplay.changes')}</span>
      {!contentPreview && <span className="shrink-0 tabular-nums"><span className="text-green-600 dark:text-green-400">+{added}</span>{' '}<span className="text-red-500 dark:text-red-400">−{removed}</span></span>}
    </span>} copyContent={contentPreview ? newText : lines.map(line => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}${line.content}`).join('\n')}>
      {lines.length === 0 ? <span>{t('toolDisplay.noChanges')}</span> : <div className="w-max min-w-full font-mono text-xs leading-5">
        {lines.map((line, index) => <div key={index} className={`flex ${line.type === 'added' ? 'bg-green-500/10' : line.type === 'removed' ? 'bg-red-500/10' : ''}`}>
          <span className="w-10 shrink-0 select-none pr-3 text-right text-neutral-400 dark:text-neutral-500">{line.lineNum}</span>
          {!contentPreview && <span className={`w-5 shrink-0 select-none ${line.type === 'added' ? 'text-green-600 dark:text-green-400' : line.type === 'removed' ? 'text-red-500 dark:text-red-400' : ''}`}>{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span>}
          <span className="whitespace-pre pr-3">{line.content || ' '}</span>
        </div>)}
      </div>}
    </ToolDetails>
  );
};
