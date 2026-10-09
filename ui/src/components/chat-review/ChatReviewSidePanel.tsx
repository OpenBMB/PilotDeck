import { useState, type MouseEvent } from 'react';
import { Files, GitBranch, History, RefreshCw } from 'lucide-react';
import ToolSidePanel from '../main-content/view/subcomponents/ToolSidePanel';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useChatReview, type RestorePlan } from './ChatReviewContext';
import GitReviewTab from './GitReviewTab';
import ChangesReviewTab from './ChangesReviewTab';
import CheckpointHistoryTab from './CheckpointHistoryTab';
import { isInternalReviewPath, visibleReviewFiles } from './reviewFiles';

function RestoreDialog({ plan }: { plan: RestorePlan }) {
  const review = useChatReview()!;
  const [selected, setSelected] = useState(plan.files.filter(file => file.status === 'ready').map(file => file.path));
  const [switching, setSwitching] = useState(false);
  const checkpoint = review.data.checkpoints.find(item => item.id === plan.checkpointId);
  const root = review.project?.fullPath || review.project?.path;
  const visibleFiles = visibleReviewFiles(plan.files, root);
  const internalFiles = plan.files.filter(file => isInternalReviewPath(file.path, root));
  const readyInternalPaths = internalFiles.filter(file => file.status === 'ready').map(file => file.path);
  const selectedVisibleCount = visibleFiles.filter(file => selected.includes(file.path)).length;
  const internalLabel = plan.undoOf ? '同时恢复本轮内部工作文件' : '同时回退本轮内部工作文件';
  const confirmLabel = plan.mode === 'conversation' ? '确认回退对话' : selectedVisibleCount > 0 ? `确认恢复 ${selectedVisibleCount} 个文件` : selected.length > 0 ? (plan.undoOf ? '确认恢复内部工作文件' : '确认回退内部工作文件') : plan.mode === 'both' ? '确认回退对话' : '确认恢复 0 个文件';
  const modeLabel = plan.mode === 'files' ? '仅撤回文件改动' : plan.mode === 'both' ? '文件和对话一起回退' : '仅回退对话';
  return <ConfirmDialog title="恢复预览" confirmLabel={confirmLabel} busy={review.restoring || switching} disabled={plan.mode === 'files' && selected.length === 0} error={review.error} onCancel={() => review.setPlan(null)} onConfirm={() => void review.restore(selected)}>
    <p>恢复前会保存当前状态。存在后续编辑的文件默认保留。</p>
    {checkpoint?.phase === 'after' ? <label className="my-3 block">恢复方式<select aria-label="恢复方式" value={plan.mode} disabled={review.restoring || switching} onChange={async event => { setSwitching(true); await review.preview(plan.checkpointId, plan.scope ?? 'turn', event.target.value as RestorePlan['mode']); setSwitching(false); }} className="mt-1 w-full rounded-md border border-border bg-background py-2 pl-2 pr-10 text-foreground"><option value="files">仅撤回文件改动，保留对话</option><option value="both">文件和对话一起回退</option><option value="conversation">仅回退对话，保留文件</option></select></label> : <p className="my-3">{modeLabel}</p>}
    {plan.mode !== 'conversation' && <div className="space-y-2">{visibleFiles.map(file => <label key={file.path} className="flex items-start gap-2 rounded-md bg-muted/50 p-2"><input type="checkbox" checked={selected.includes(file.path)} disabled={file.status !== 'ready' || review.restoring} onChange={event => setSelected(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} className="mt-1" /><span className="min-w-0"><span className="break-all font-mono text-xs">{file.path}</span><span className="mt-1 block text-xs">{file.status === 'conflict' ? '有后续修改，保留该文件' : file.status === 'unprotected' ? '缺少可恢复备份，保留该文件' : file.status === 'unchanged' ? '已经是目标版本，无需修改' : file.target.kind === 'absent' ? '删除本轮新增文件' : '恢复原有内容'}{file.source === 'observed' ? ' · 目录中检测到的变化' : ''}</span></span></label>)}
      {readyInternalPaths.length > 0 && <label className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs"><input type="checkbox" checked={readyInternalPaths.every(path => selected.includes(path))} disabled={review.restoring} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, ...readyInternalPaths])] : previous.filter(path => !readyInternalPaths.includes(path)))} /><span>{internalLabel}</span></label>}
      {internalFiles.some(file => file.status === 'conflict' || file.status === 'unprotected') && <p className="text-xs">部分内部工作文件存在后续修改或缺少备份，将保留。</p>}
      {internalFiles.length > 0 && internalFiles.every(file => file.status === 'unchanged') && <p className="text-xs">内部工作文件已是目标版本，无需修改。</p>}
    </div>}
    {plan.mode === 'both' && <p className="mt-3">对话将回到目标轮次之前；冲突文件继续保留，Agent 会收到文件恢复说明。</p>}
  </ConfirmDialog>;
}

export default function ChatReviewSidePanel({ width, minWidth, maxWidth, isMobile, onResizeStart, onResizeBy }: {
  width: number; minWidth: number; maxWidth: number; isMobile: boolean; onResizeStart: (event: MouseEvent<HTMLDivElement>) => void; onResizeBy: (delta: number) => void;
}) {
  const review = useChatReview();
  if (!review?.panelOpen) return null;
  const header = <div className="flex min-w-0 flex-1 items-center gap-1">
    <button type="button" onClick={() => review.open('changes')} aria-pressed={review.tab === 'changes'} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${review.tab === 'changes' ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}><Files className="h-3.5 w-3.5" />变更</button>
    <button type="button" onClick={() => review.open('git')} aria-pressed={review.tab === 'git'} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ${review.tab === 'git' ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}><GitBranch className="h-3.5 w-3.5" />Git</button>
    <button type="button" aria-label="检查点历史" onClick={() => review.open('checkpoints')} aria-pressed={review.tab === 'checkpoints'} className={`rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${review.tab === 'checkpoints' ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100' : 'text-neutral-400'}`}><History className="h-3.5 w-3.5" /></button>
    <button type="button" className="ml-auto rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="刷新改动和 Git 状态" onClick={() => { void review.refresh(); void review.refreshGit(); }}><RefreshCw className={`h-3.5 w-3.5 ${review.loading ? 'animate-spin' : ''}`} /></button>
  </div>;
  return <><ToolSidePanel title="改动与版本" icon={Files} headerContent={header} width={width} minWidth={minWidth} maxWidth={maxWidth} isMobile={isMobile} closeLabel="收起改动面板" resizeLabel="调整改动面板宽度" onClose={review.close} onResizeStart={onResizeStart} onResizeBy={onResizeBy}>
    <div className="flex h-full min-h-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100" data-testid="chat-review-panel">
      {review.error && <div role="alert" className="shrink-0 break-words bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">{review.error}</div>}
      {(review.running || review.data.busy) && <div className="shrink-0 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">目录正在修改，完成或停止后可恢复和操作 Git。</div>}
      <div className={`min-h-0 flex-1 ${review.tab === 'changes' ? 'overflow-hidden' : 'overflow-y-auto'}`}>{review.tab === 'changes' ? <ChangesReviewTab wide={!isMobile && width >= 700} /> : review.tab === 'checkpoints' ? <CheckpointHistoryTab /> : <GitReviewTab />}</div>
    </div>
  </ToolSidePanel>{review.plan && <RestoreDialog key={review.plan.id} plan={review.plan} />}</>;
}
