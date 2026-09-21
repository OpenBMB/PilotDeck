import { useCallback, useEffect, useRef, useState } from 'react';
import { CirclePause, Loader2, RefreshCw } from 'lucide-react';

import { api } from '../../utils/api';

type SopWait = {
  id: string;
  kind: 'handoff' | 'external_task';
  skillId?: string;
  stepId?: string;
};

type SopStatus = {
  sessionId: string;
  revision: number;
  state: Record<string, unknown>;
  wait?: SopWait;
};

type SopWaitBannerProps = {
  sessionKey: string | null;
  projectKey: string;
  refreshKey: string;
  disabled?: boolean;
  onPrepared: (message: string) => void;
  onError: (message: string) => void;
};

export default function SopWaitBanner({
  sessionKey,
  projectKey,
  refreshKey,
  disabled = false,
  onPrepared,
  onError,
}: SopWaitBannerProps) {
  const [status, setStatus] = useState<SopStatus | null>(null);
  const draftKey = sessionKey ? `pilotdeck:sop:continuation:${sessionKey}` : null;
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const waitIdRef = useRef<string | undefined>(undefined);
  const messageInputRef = useRef<HTMLInputElement | null>(null);
  const statusRequestRef = useRef(0);
  const resumeInFlightRef = useRef(false);

  useEffect(() => {
    if (messageInputRef.current) messageInputRef.current.value = readDraft(draftKey);
  }, [draftKey]);

  const loadStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current;
    if (!sessionKey) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      const response = await api.sopStatus(sessionKey, projectKey);
      if (requestId !== statusRequestRef.current) return;
      if (!response.ok) {
        if (response.status === 404 || response.status === 501 || response.status === 503) {
          setStatus(null);
          return;
        }
        throw new Error(await responseMessage(response, 'Unable to read SOP status.'));
      }
      const body = await response.json();
      const nextStatus = isSopStatus(body?.status) ? body.status : null;
      const nextWaitId = nextStatus?.wait?.id;
      // The first status response may arrive after the operator starts
      // typing. Only a subsequent, distinct handoff should replace a draft.
      if (nextWaitId && waitIdRef.current && waitIdRef.current !== nextWaitId) {
        waitIdRef.current = nextWaitId;
        writeDraft(draftKey, '');
        if (messageInputRef.current) messageInputRef.current.value = '';
      }
      if (!waitIdRef.current && nextWaitId) waitIdRef.current = nextWaitId;
      setStatus(nextStatus);
    } catch (error) {
      if (requestId !== statusRequestRef.current) return;
      setStatus(null);
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === statusRequestRef.current) setLoading(false);
    }
  }, [onError, projectKey, sessionKey]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, refreshKey]);

  if (!status?.wait) return null;
  const wait = status.wait;

  const resume = async () => {
    const normalizedMessage = messageInputRef.current?.value.trim() ?? '';
    if (!normalizedMessage || resuming || disabled || resumeInFlightRef.current) return;
    resumeInFlightRef.current = true;
    setResuming(true);
    try {
      const response = await api.resumeSop({
        sessionKey: status.sessionId,
        projectKey,
        requestId: crypto.randomUUID(),
        waitId: wait.id,
        source: wait.kind === 'handoff' ? 'human' : 'external_task',
        message: normalizedMessage,
        expectedRevision: status.revision,
      });
      if (!response.ok) throw new Error(await responseMessage(response, 'Unable to resume SOP.'));
      const result = await response.json();
      if (typeof result?.message !== 'string' || !result.message.trim()) {
        throw new Error('SOP resume did not return a continuation message.');
      }
      setStatus(null);
      writeDraft(draftKey, '');
      onPrepared(result.message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      await loadStatus();
    } finally {
      resumeInFlightRef.current = false;
      setResuming(false);
    }
  };

  const label = wait.kind === 'handoff'
    ? 'This SOP is waiting for a handoff response.'
    : 'This SOP is waiting for an external task result.';

  return (
    <div
      className="border-t border-neutral-200 bg-neutral-50 px-6 py-3 dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="sop-wait-banner"
    >
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-3">
        <CirclePause className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">{label}</div>
          <input
            ref={messageInputRef}
            aria-label="SOP continuation message"
            className="mt-1 h-9 w-full border-0 border-b border-neutral-300 bg-transparent px-0 text-[13px] text-neutral-900 outline-none focus:border-blue-500 dark:border-neutral-700 dark:text-neutral-100"
            defaultValue={readDraft(draftKey)}
            onChange={(event) => {
              writeDraft(draftKey, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void resume();
            }}
            placeholder={wait.kind === 'handoff' ? 'Enter the handoff response' : 'Enter the external task result'}
            disabled={disabled || resuming}
          />
        </div>
        <button
          type="button"
          className="flex h-9 shrink-0 items-center gap-2 rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          onClick={() => void resume()}
          disabled={disabled || resuming}
        >
          {resuming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Continue
        </button>
        <button
          type="button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
          onClick={() => void loadStatus()}
          disabled={loading || resuming}
          aria-label="Refresh SOP status"
          title="Refresh SOP status"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function isSopStatus(value: unknown): value is SopStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<SopStatus>;
  return typeof status.sessionId === 'string'
    && Number.isSafeInteger(status.revision)
    && typeof status.state === 'object'
    && status.state !== null;
}

function readDraft(key: string | null): string {
  if (!key) return '';
  try { return window.sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}

function writeDraft(key: string | null, value: string): void {
  if (!key) return;
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch { /* Session storage is optional draft persistence. */ }
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.message === 'string') return body.error.message;
  } catch {
    // Use the stable fallback for non-JSON proxy failures.
  }
  return fallback;
}
