import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../../../utils/api';

/** A settings read never polls, and leaving the page releases its request. */
export function useRuntimeStatus<T extends { state: string }>(url: string, states: readonly string[], key?: boolean, checkUrl?: string) {
  const [status, setStatus] = useState<T | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<'failed' | 'timeout' | null>(null);
  const current = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancel = useCallback(() => {
    const request = current.current; current.current = null;
    if (request) { clearTimeout(request.timer); request.controller.abort(); }
  }, []);
  const refresh = useCallback(async (fullCheck = false) => {
    cancel(); setChecking(true); setError(null);
    const controller = new AbortController();
    const request = { controller, timer: setTimeout(() => {
      if (current.current !== request) return;
      setError('timeout'); setChecking(false); controller.abort();
    }, fullCheck && checkUrl ? 90_000 : 20_000) };
    current.current = request;
    try {
      const response = await authenticatedFetch(fullCheck && checkUrl ? checkUrl : url, {
        method: fullCheck && checkUrl ? 'POST' : 'GET', signal: controller.signal, suppressServerErrorToast: true,
      });
      if (!response.ok) throw new Error('Runtime status unavailable');
      const value = await response.json();
      if (!value || !states.includes(value.state)) throw new Error('Invalid runtime status');
      if (current.current === request && !controller.signal.aborted) setStatus(value);
    } catch {
      if (current.current === request && !controller.signal.aborted) setError('failed');
    } finally {
      clearTimeout(request.timer);
      if (current.current === request) setChecking(false);
    }
  }, [url, checkUrl, states, cancel]);
  useEffect(() => { void refresh(); return cancel; }, [refresh, key, cancel]);
  return { status, checking, error, refresh };
}
