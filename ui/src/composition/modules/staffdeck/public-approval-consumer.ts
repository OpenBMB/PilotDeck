import { useCallback, useEffect, useRef, useState } from 'react';
import { approvalInboxItem, createPublicApprovalClient, type ApprovalScope, type ApprovalStatus, type PinnedApproval } from './public-approval-client';

export type ApprovalInboxConsumerOptions = {
  scope: ApprovalScope | null;
  readApproverBearer?: () => string;
  refreshKey?: string;
  onPrepared?: (message: string) => void;
  onError?: (message: string) => void;
};

/** One browser consumer for the PD extension and the SD canonical inbox slot. */
export function usePublicApprovalInbox({ scope, readApproverBearer, refreshKey, onPrepared, onError }: ApprovalInboxConsumerOptions) {
  const [status, setStatus] = useState<ApprovalStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const statusAbort = useRef<AbortController | null>(null);
  const replyAbort = useRef<AbortController | null>(null);
  const scopeKey = scope ? `${scope.projectKey ?? ''}\0${scope.sessionKey}` : '';
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const pendingScope = useRef(scopeKey);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const inputs = useRef({ scope, readApproverBearer, onPrepared, onError });
  inputs.current = { scope, readApproverBearer, onPrepared, onError };
  const bearer = useCallback(() => inputs.current.readApproverBearer?.() ?? '', []);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    statusAbort.current?.abort();
    const { scope: selectedScope } = inputs.current;
    if (!selectedScope) {
      setStatus(null);
      setLoading(false);
      setError('SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE');
      return;
    }
    if (!bearer()) {
      setStatus(null);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    statusAbort.current = controller;
    setLoading(true);
    try {
      const next = await createPublicApprovalClient(bearer).status(selectedScope, { signal: controller.signal });
      if (current !== generation.current || controller.signal.aborted) return;
      setStatus(next);
      setError('');
    } catch (cause) {
      if (current !== generation.current || controller.signal.aborted) return;
      setStatus(null);
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      inputs.current.onError?.(message);
    } finally {
      if (current === generation.current && !controller.signal.aborted) setLoading(false);
    }
  }, [scopeKey, bearer]);

  useEffect(() => {
    if (pendingScope.current !== scopeKey) pending.current = null;
    pendingScope.current = scopeKey;
    inFlight.current = false;
    setSubmitting(false);
    setStatus(null);
    setError('');
    void refresh();
    return () => { generation.current++; statusAbort.current?.abort(); replyAbort.current?.abort(); };
  }, [refresh, refreshKey]);

  const onReply = useCallback(async (approval: PinnedApproval, message: string): Promise<void> => {
    const selectedScope = inputs.current.scope;
    if (!selectedScope || inFlight.current || status?.approvalError) return;
    const pinned = approvalInboxItem(status);
    if (!pinned || pinned.waitId !== approval.waitId || pinned.revision !== approval.revision ||
        pinned.skillId !== approval.skillId || pinned.version !== approval.version ||
        pinned.nodeId !== approval.nodeId || pinned.assigneeUserId !== approval.assigneeUserId) {
      setError('SOP_APPROVAL_WAIT_STALE');
      return;
    }
    const normalized = message.trim();
    if (!normalized) return;
    const key = `${scopeKey}\0${pinned.waitId}\0${pinned.revision}\0${normalized}`;
    const requestId = pending.current?.key === key ? pending.current.requestId : crypto.randomUUID();
    pending.current = { key, requestId };
    const controller = new AbortController();
    replyAbort.current = controller;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const receipt = await createPublicApprovalClient(bearer).resume({ ...selectedScope, requestId,
        waitId: pinned.waitId, expectedRevision: pinned.revision, message: normalized }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      pending.current = null;
      inputs.current.onPrepared?.(receipt.message);
      await refresh();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const failure = cause instanceof Error ? cause.message : String(cause);
      setError(failure);
      inputs.current.onError?.(failure);
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }, [scopeKey, status, bearer, refresh]);

  return { status, loading, submitting, error, onReply, refresh };
}
