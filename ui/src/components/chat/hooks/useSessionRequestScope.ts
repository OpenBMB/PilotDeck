import { useEffect, useMemo, useRef } from 'react';
import type { Project, ProjectSession } from '../../../types/app';
import type { SessionSlot } from '../../../stores/useSessionStore';
import { getSessionRequestIdentity } from '../utils/sessionRequestIdentity';

export type HistoryRequestKind = 'initial' | 'older' | 'full' | 'refresh';
export type HistoryRequestResult =
  | { status: 'success'; slot: SessionSlot }
  | { status: 'error'; error: Error }
  | { status: 'stale' };

/** A selection owns requests until it changes, including an A -> B -> A revisit. */
export function useSessionRequestScope(project: Project | null, session: ProjectSession | null) {
  const selection = getSessionRequestIdentity(project, session);
  const current = useRef<object | null>(null);
  const lifetime = useRef({ mounted: true, epoch: 0 });
  useEffect(() => {
    lifetime.current.mounted = true;
    return () => { lifetime.current.mounted = false; lifetime.current.epoch += 1; };
  }, []);

  const scope = useMemo(() => {
    if (!selection) return null;
    const identity = {};
    const pending = new Map<string, { epoch: number; request: Promise<HistoryRequestResult> }>();
    let sequence = 0;
    let appliedSequence = 0;
    const capture = () => {
      const epoch = lifetime.current.epoch;
      return () => current.current === identity && lifetime.current.mounted && lifetime.current.epoch === epoch;
    };
    return {
      ...selection, identity,
      capture,
      run(kind: HistoryRequestKind, load: () => Promise<SessionSlot | null | undefined>, variant = ''): Promise<HistoryRequestResult> {
        const requestKey = `${kind}:${variant}`;
        const existing = pending.get(requestKey);
        if (existing?.epoch === lifetime.current.epoch) return existing.request;
        const isCurrent = capture();
        const epoch = lifetime.current.epoch;
        const requestSequence = ++sequence;
        let request!: Promise<HistoryRequestResult>;
        request = (async (): Promise<HistoryRequestResult> => {
          try {
            const slot = await Promise.resolve().then(() => isCurrent() ? load() : undefined);
            if (!isCurrent() || requestSequence < appliedSequence) return { status: 'stale' };
            if (slot === undefined || slot?.status === 'loading') return { status: 'stale' };
            appliedSequence = requestSequence;
            if (!slot || slot.status === 'error') return { status: 'error', error: new Error(slot?.lastError || 'Unable to load conversation messages.') };
            return { status: 'success', slot };
          } catch (error) {
            if (!isCurrent() || requestSequence < appliedSequence) return { status: 'stale' };
            appliedSequence = requestSequence;
            return { status: 'error', error: error instanceof Error ? error : new Error(String(error)) };
          } finally {
            if (pending.get(requestKey)?.request === request) pending.delete(requestKey);
          }
        })();
        pending.set(requestKey, { epoch, request });
        return request;
      },
    };
    // The serialized key contains every field in the immutable request options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.key]);
  current.current = scope?.identity ?? null;
  return scope;
}
