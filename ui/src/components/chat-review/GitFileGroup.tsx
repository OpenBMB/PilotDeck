import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ListX, Minus, Plus } from 'lucide-react';
import { FileTypeIcon } from '../file-tree/components/FileTypeIcon';
import type { GitEntry } from './ChatReviewContext';

type Props = {
  label: string;
  files: GitEntry[];
  side: 'staged' | 'unstaged';
  selected: string[];
  blocked: boolean;
  onSelection: (paths: string[], checked: boolean) => void;
  onAction: (files: GitEntry[]) => void;
  onDiff: (file: GitEntry) => void;
};
const iconButton = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-default disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100';
const statusColor = (code: string) => code === 'A' || code === '?' ? 'text-emerald-600 dark:text-emerald-400'
  : code === 'D' ? 'text-red-500' : code === 'R' || code === 'C' ? 'text-blue-500' : 'text-amber-600 dark:text-amber-400';

export default function GitFileGroup({ label, files, side, selected, blocked, onSelection, onAction, onDiff }: Props) {
  const [expanded, setExpanded] = useState(true);
  const checkbox = useRef<HTMLInputElement>(null), listId = useId();
  const selectedFiles = files.filter(file => selected.includes(file.path));
  const allSelected = files.length > 0 && selectedFiles.length === files.length;
  const partial = selectedFiles.length > 0 && !allSelected;
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = partial; }, [partial]);
  const actionFiles = selectedFiles.length ? selectedFiles : files;
  const actionLabel = side === 'staged' ? selectedFiles.length ? '取消暂存所选' : '取消暂存全部'
    : selectedFiles.length ? '暂存所选' : '暂存全部';
  const ActionIcon = side === 'staged' ? Minus : Plus;
  return <section role="group" aria-label={label} className="overflow-hidden rounded-md border border-neutral-200/70 dark:border-neutral-800">
    <div className="flex h-8 items-center gap-1.5 bg-neutral-50 px-2 dark:bg-neutral-900/70">
      <input ref={checkbox} type="checkbox" aria-label={`${allSelected ? '取消全选' : '全选'}${label}文件`}
        aria-checked={partial ? 'mixed' : allSelected} checked={allSelected} disabled={!files.length}
        onChange={event => onSelection(files.map(file => file.path), event.target.checked)} className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-600" />
      <button type="button" aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded(value => !value)} className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium">
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="truncate">{label}</span>
        <span className="ml-1 rounded bg-neutral-200/70 px-1.5 py-0.5 text-[10px] tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          {selectedFiles.length ? `${selectedFiles.length}/${files.length}` : files.length}
        </span>
      </button>
      {selectedFiles.length > 0 && <button type="button" aria-label={`取消选择${label}文件`} title="取消选择" className={iconButton}
        onClick={() => onSelection(files.map(file => file.path), false)}><ListX aria-hidden="true" className="h-3.5 w-3.5" /></button>}
      <button type="button" aria-label={actionLabel} title={`${actionLabel}（${actionFiles.length} 个文件）`} className={iconButton}
        disabled={blocked || !actionFiles.length} onClick={() => onAction(actionFiles)}><ActionIcon aria-hidden="true" className="h-4 w-4" /></button>
    </div>
    {expanded && <div id={listId}>{files.map(file => {
      const slash = file.path.lastIndexOf('/'), name = file.path.slice(slash + 1), directory = slash >= 0 ? file.path.slice(0, slash) : '';
      const code = file.untracked ? '?' : side === 'staged' ? file.indexStatus : file.worktreeStatus;
      const checked = selected.includes(file.path);
      return <div key={file.path} className={`group flex h-8 items-center gap-2 px-2 hover:bg-neutral-50 dark:hover:bg-neutral-900 ${checked ? 'bg-violet-500/5' : ''}`}>
        <input type="checkbox" aria-label={`选择${label}文件 ${file.path}`} checked={checked}
          onChange={event => onSelection([file.path], event.target.checked)} className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-600" />
        <button type="button" aria-label={`查看${label}差异 ${file.path}`} title={file.originalPath ? `${file.path}\n← ${file.originalPath}` : file.path}
          onClick={() => onDiff(file)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-violet-600 dark:hover:text-violet-400">
          <FileTypeIcon filename={name} className="h-3.5 w-3.5" />
          <span className="min-w-0 truncate">{name}</span>
          {(directory || file.originalPath) && <span className="min-w-0 shrink-[2] truncate text-[10px] text-neutral-400">{file.originalPath ? `← ${file.originalPath}` : directory}</span>}
        </button>
        <button type="button" aria-label={`${side === 'staged' ? '取消暂存' : '暂存'} ${file.path}`} title={side === 'staged' ? '取消暂存' : '暂存'}
          className={`${iconButton} opacity-60 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100`}
          disabled={blocked} onClick={() => onAction([file])}><ActionIcon aria-hidden="true" className="h-3.5 w-3.5" /></button>
        <span title={code === '?' ? '未跟踪' : code === 'A' ? '新增' : code === 'D' ? '删除' : code === 'R' ? '重命名' : file.conflicted ? '冲突' : '修改'}
          className={`w-3 shrink-0 text-center font-mono text-[11px] font-medium ${statusColor(code)}`}>{code}</span>
      </div>;
    })}</div>}
  </section>;
}
