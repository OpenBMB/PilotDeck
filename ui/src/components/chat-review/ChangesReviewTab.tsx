import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { GitBranch, Loader2, PanelLeft, Search, Undo2 } from 'lucide-react';
import { activeRestoration, useChatReview } from './ChatReviewContext';
import type { CheckpointDiff } from './CheckpointDiffViewer';
import { FileTypeIcon } from '../file-tree/components/FileTypeIcon';
import { visibleReviewFiles } from './reviewFiles';

const EMPTY_FILES: NonNullable<ReturnType<typeof useChatReview>>['data']['sessionChanges'] = [];

const CheckpointDiffViewer = lazy(() => import('./CheckpointDiffViewer'));

export default function ChangesReviewTab({ wide }: { wide: boolean }) {
  const review = useChatReview()!;
  const records = review.data.checkpoints.filter(item => item.phase === 'after');
  const checkpoint = records.find(item => item.id === review.checkpointId) ?? records.filter(item => item.activeBranch !== false).at(-1) ?? records.at(-1);
  const rawFiles = review.scope === 'session' ? review.data.sessionChanges : checkpoint?.changes ?? EMPTY_FILES;
  const root = review.project?.fullPath || review.project?.path;
  const files = useMemo(() => visibleReviewFiles(rawFiles, root), [rawFiles, root]);
  const [requestedFile, setFile] = useState<string | null>(review.filePath);
  const file = files.find(changed => changed.path === requestedFile)?.path ?? files[0]?.path ?? null;
  const [loadedDiff, setDiff] = useState<{ key: string; value: CheckpointDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(wide), [filter, setFilter] = useState('');
  const sessionRevision = review.scope === 'session' ? review.data.sessionRevision ?? JSON.stringify(review.data.sessionChanges) : '';
  const diffKey = `${checkpoint?.id}:${review.scope}:${file}:${sessionRevision}`;
  const diff = loadedDiff?.key === diffKey ? loadedDiff.value : null;
  useEffect(() => { setShowFiles(wide); }, [wide]);
  useEffect(() => { setFile(review.filePath); }, [review.filePath, checkpoint?.id]);
  useEffect(() => {
    if (!checkpoint || !file) { setDiff(null); return; }
    let current = true;
    setDiff(null); setError(null);
    void review.request<CheckpointDiff>('diff', { checkpointId: checkpoint.id, filePath: file, scope: review.scope }).then(
      result => { if (current) setDiff({ key: diffKey, value: result }); },
      failure => { if (current) setError(failure.message); },
    );
    return () => { current = false; };
  }, [checkpoint?.id, file, review.scope, review.request, diffKey]);
  if (!checkpoint) return <div className="flex h-full items-center justify-center p-8 text-center text-xs leading-6 text-neutral-500">{review.loading ? '正在读取检查点…' : '该对话尚无文件变更记录。'}</div>;
  const selected = files.find(changed => changed.path === file);
  const restoration = review.scope === 'turn' ? activeRestoration(review.data.operations, checkpoint.id) : null;
  const filtered = files.filter(changed => changed.path.toLowerCase().includes(filter.toLowerCase()));
  const selectFile = (path: string) => { setFile(path); if (!wide) setShowFiles(false); };
  return <div className="flex h-full min-h-0 flex-col text-xs" data-testid="changes-review-tab">
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800">
      <select aria-label="审阅范围" value={review.scope === 'session' ? 'session' : checkpoint.id} onChange={event => { if (event.target.value === 'session') review.setScope('session'); else review.open('changes', event.target.value); }} className="min-w-0 max-w-[55%] rounded-lg border border-neutral-200 bg-transparent py-1.5 pl-2 pr-10 dark:border-neutral-700">
        {records.slice().reverse().map(record => <option key={record.id} value={record.id}>{record.id === records.at(-1)?.id ? '本轮' : '历史轮次'} · {new Date(record.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{record.activeBranch === false ? ' · 先前分支' : ''}</option>)}
        <option value="session">本会话净变更</option>
      </select>
      {files.some(changed => !changed.binary) && <span className="shrink-0 tabular-nums"><span className="text-emerald-600 dark:text-emerald-400">+{files.reduce((sum, changed) => sum + changed.added, 0)}</span> <span className="text-red-500">−{files.reduce((sum, changed) => sum + changed.removed, 0)}</span></span>}
      <button type="button" aria-label={showFiles ? '收起文件导航' : '展开文件导航'} aria-pressed={showFiles} onClick={() => setShowFiles(value => !value)} className={`ml-auto rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${showFiles ? 'text-violet-600 dark:text-violet-400' : 'text-neutral-400'}`}><PanelLeft className="h-4 w-4" /></button>
    </div>
    <div className="relative flex min-h-0 flex-1">
      {showFiles && <nav aria-label="变更文件" className={`${wide ? 'relative w-56 shrink-0' : 'absolute inset-y-0 left-0 z-20 w-[min(280px,100%)] shadow-lg'} flex min-h-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950`}>
        <label className="m-2 flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2 dark:border-neutral-800"><Search className="h-3.5 w-3.5 text-neutral-400" /><input aria-label="筛选变更文件" value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选文件…" className="min-w-0 flex-1 bg-transparent py-1.5 outline-none" /></label>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.map(changed => <button type="button" key={changed.path} onClick={() => selectFile(changed.path)} aria-current={file === changed.path ? 'true' : undefined} title={changed.path} className={`flex w-full items-start gap-2 px-3 py-2.5 text-left ${file === changed.path ? 'bg-violet-500/[0.06]' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'}`}>
            <FileTypeIcon filename={changed.path} className="mt-0.5 h-4 w-4 shrink-0" assetClassName="h-4 w-4" />
            <span className="min-w-0 flex-1"><span className="block truncate text-neutral-700 dark:text-neutral-200">{changed.path.split('/').at(-1)}</span>{changed.path.includes('/') && <span className="mt-0.5 block truncate text-[10px] text-neutral-400">{changed.path.slice(0, changed.path.lastIndexOf('/'))}</span>}</span>
            <span className={`shrink-0 text-[10px] ${changed.operation === 'deleted' ? 'text-red-500' : 'text-neutral-400'}`}>{changed.operation === 'created' ? 'A' : changed.operation === 'deleted' ? 'D' : 'M'}</span>
          </button>)}
          {!filtered.length && <p className="p-4 text-neutral-400">没有匹配的文件。</p>}
        </div>
        <div className="shrink-0 border-t border-neutral-100 px-3 py-2 text-[11px] text-neutral-400 dark:border-neutral-800">{files.length} 个文件</div>
      </nav>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected && <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800">
          <FileTypeIcon filename={selected.path} className="h-4 w-4 shrink-0" assetClassName="h-4 w-4" />
          <select aria-label="查看变更文件" value={file ?? ''} onChange={event => selectFile(event.target.value)} title={selected.path} className="min-w-0 flex-1 bg-transparent py-2 font-medium">{files.map(changed => <option key={changed.path} value={changed.path}>{changed.path}</option>)}</select>
          <span className="shrink-0 text-[11px] text-neutral-400">{selected.operation === 'created' ? '新增' : selected.operation === 'deleted' ? '删除' : '修改'}</span>
          {!selected.binary && <span className="shrink-0 tabular-nums"><span className="text-emerald-600 dark:text-emerald-400">+{selected.added}</span> <span className="text-red-500">−{selected.removed}</span></span>}
        </div>}
        {error ? <p role="alert" className="p-4 text-red-500">{error}</p> : diff ? <Suspense fallback={<div className="p-4 text-neutral-400">读取差异…</div>}><CheckpointDiffViewer key={diffKey} diff={diff} versionLabel={review.scope === 'session' ? '本会话汇总版本' : '本轮保存的版本'} /></Suspense> : file ? <div className="flex flex-1 items-center justify-center gap-2 text-neutral-400"><Loader2 className="h-4 w-4 animate-spin" />读取差异…</div> : <div className="flex flex-1 items-center justify-center p-8 text-center text-neutral-400">当前范围没有用户文件变更。</div>}
      </div>
    </div>
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
      <button type="button" disabled={review.running || review.data.busy || review.readOnly || !rawFiles.length} onClick={() => { if (restoration) void review.undo(restoration.id); else void review.preview(checkpoint.id, review.scope); }} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"><Undo2 className="h-3.5 w-3.5" />{restoration ? '撤销此次恢复' : review.scope === 'turn' ? '撤销本轮改动' : '撤销会话改动'}</button>
      <button type="button" onClick={() => review.open('git', checkpoint.id)} className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><GitBranch className="h-3.5 w-3.5" />暂存与提交</button>
    </div>
  </div>;
}
