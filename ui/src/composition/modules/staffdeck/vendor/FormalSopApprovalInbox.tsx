import { useEffect, useState, type FormEvent } from 'react';
import { USER_CONTENT_ATTRIBUTES } from './FormalUserContent';

/** The authenticated adapter supplies the original pinned session projection. */
export type FormalSopApproval = Readonly<{
  waitId: string;
  revision: number;
  skillId: string;
  version: string;
  nodeId: string;
  assigneeUserId: string;
}>;
export type FormalSopApprovalStatus = Readonly<{
  sessionId: string;
  revision: number;
  approval?: FormalSopApproval;
  approvalError?: Readonly<{ code: string; message: string }>;
}>;
export type FormalSopApprovalInboxProps = {
  status: FormalSopApprovalStatus | null;
  loading?: boolean;
  submitting?: boolean;
  error?: string;
  draftStorageKey?: string;
  onReply: (approval: FormalSopApproval, message: string) => void | Promise<void>;
};

/** UI-only draft text. The callback owns authenticated resume/request ID and receipt handling. */
export default function FormalSopApprovalInbox({ status, loading = false, submitting = false, error, draftStorageKey, onReply }: FormalSopApprovalInboxProps) {
  const readDraft = () => { try { return draftStorageKey ? sessionStorage.getItem(draftStorageKey) || '' : ''; } catch { return ''; } };
  const [message, setMessage] = useState(readDraft);
  const approval = status?.approval;
  useEffect(() => setMessage(readDraft()), [status?.sessionId, approval?.waitId, approval?.revision, draftStorageKey]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reply = message.trim();
    if (!approval || submitting || !reply || !Number.isInteger(approval.revision) || approval.revision < 0) return;
    void onReply(approval, reply);
  }

  return <section aria-label="SOP 人工审批" className="rounded-xl border border-border bg-background p-4 text-foreground">
    <h2 className="text-base font-semibold">SOP 人工审批</h2>
    {loading ? <p role="status" className="mt-3 text-sm text-muted-foreground">正在加载审批</p>
      : status?.approvalError ? <p role="alert" {...USER_CONTENT_ATTRIBUTES} className="mt-3 text-sm text-destructive">{status.approvalError.message}</p>
        : !approval ? <p className="mt-3 text-sm text-muted-foreground">当前会话没有待处理的人工审批</p>
          : <form onSubmit={submit} className="mt-3 space-y-3">
            <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
              <dt>技能</dt><dd {...USER_CONTENT_ATTRIBUTES} className="min-w-0 break-all">{approval.skillId}</dd>
              <dt>固定版本</dt><dd {...USER_CONTENT_ATTRIBUTES}>{approval.version}</dd>
              <dt>节点</dt><dd {...USER_CONTENT_ATTRIBUTES} className="min-w-0 break-all">{approval.nodeId}</dd>
            </dl>
            <label className="block text-sm font-medium">人工回复</label>
            <textarea aria-label="人工回复" value={message} onChange={(event) => { setMessage(event.target.value); if (draftStorageKey) { try { sessionStorage.setItem(draftStorageKey, event.target.value); } catch { /* In-memory editing remains available. */ } } }}
              disabled={submitting} rows={3} className="w-full rounded-lg border border-input bg-background p-2 text-sm" />
            {error && <p role="alert" {...USER_CONTENT_ATTRIBUTES} className="text-sm text-destructive">{error}</p>}
            <button type="submit" disabled={submitting || !message.trim() || !Number.isInteger(approval.revision) || approval.revision < 0}
              className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
              {submitting ? '正在提交' : '回复并恢复'}
            </button>
          </form>}
  </section>;
}
