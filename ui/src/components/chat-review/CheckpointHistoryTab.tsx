import { Files, RotateCcw, Undo2 } from 'lucide-react';
import { useChatReview } from './ChatReviewContext';
import { visibleReviewFiles } from './reviewFiles';

const button = 'inline-flex items-center justify-center rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900';

export default function CheckpointHistoryTab() {
  const review = useChatReview()!;
  // These are events in one history, not separately ordered categories.
  const entries = [
    ...review.data.checkpoints.filter(record => record.phase === 'after').map(record => ({ kind: 'checkpoint' as const, record })),
    ...review.data.operations.map(record => ({ kind: 'operation' as const, record })),
  ].sort((left, right) => Date.parse(right.record.createdAt) - Date.parse(left.record.createdAt));
  const root = review.project?.fullPath || review.project?.path;
  const blocked = review.running || review.data.busy || review.readOnly || review.restoring;

  return <div className="space-y-4 p-4 text-xs">
    <div className="flex items-center justify-between"><h2 className="font-medium">检查点历史</h2><span className="text-[11px] text-neutral-400">最新在前</span></div>
    {!entries.length && <p className="py-8 text-center text-neutral-400">新轮次开始后会出现检查点。</p>}
    <ol aria-label="版本时间轴">
      {entries.map((entry, index) => {
        const date = new Date(entry.record.createdAt);
        const startsDay = index === 0 || date.toDateString() !== new Date(entries[index - 1].record.createdAt).toDateString();
        const checkpoint = entry.kind === 'checkpoint' ? entry.record : null;
        const operation = entry.kind === 'operation' ? entry.record : null;
        const Icon = checkpoint ? Files : operation?.undoOf ? Undo2 : RotateCcw;
        const title = checkpoint ? checkpoint.status === 'complete' ? '完成轮次' : '轮次未完成'
          : operation?.undoOf ? '撤销恢复' : operation?.mode === 'conversation' ? '回退对话' : operation?.mode === 'both' ? '回退文件与对话' : '恢复文件';
        return <li key={`${entry.kind}:${entry.record.id}`} data-history-id={entry.record.id}>
          {startsDay && <h3 className={`${index > 0 ? 'pt-3' : ''} mb-3 text-[11px] font-medium text-neutral-500`}>{date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</h3>}
          <div className="relative ml-3 border-l border-neutral-200 pb-5 pl-5 dark:border-neutral-800">
            <span aria-hidden="true" className={`absolute -left-3 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-white dark:bg-neutral-950 ${checkpoint ? 'text-violet-500' : 'text-neutral-500'}`}><Icon className="h-3.5 w-3.5" strokeWidth={1.75} /></span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5"><time dateTime={entry.record.createdAt} title={date.toLocaleString()} className="tabular-nums text-neutral-500">{date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time><span className="font-medium">{title}</span>{index === 0 && <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">最新</span>}</div>
            {checkpoint && <>
              <p className="mt-1 leading-5 text-neutral-500">{visibleReviewFiles(checkpoint.changes, root).length} 个文件 · {checkpoint.status === 'complete' ? '完成' : '执行未完成'}{checkpoint.activeBranch === false ? ' · 先前分支' : ''}{checkpoint.unprotected > 0 ? ' · 部分文件缺少备份' : ''}</p>
              <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} onClick={() => review.open('changes', checkpoint.id)}>查看改动</button><button type="button" className={button} disabled={blocked} onClick={() => void review.preview(checkpoint.id, checkpoint.activeBranch === false ? 'turn' : 'since')}>回到此轮开始前</button></div>
            </>}
            {operation && <>
              <p className="mt-1 leading-5 text-neutral-500">{operation.status === 'complete' ? '已完成' : operation.status === 'needs_recovery' ? '恢复中断，可恢复已处理文件' : '正在恢复'}</p>
              <button type="button" className={`${button} mt-2`} disabled={blocked} onClick={() => void review.undo(operation.id)}>{operation.undoOf ? '撤销此次操作' : '撤销这次恢复'}</button>
            </>}
          </div>
        </li>;
      })}
    </ol>
  </div>;
}
