import { useEffect, useRef } from 'react';
import type { PendingPermissionRequest } from '../types/types';
import {
  APPROVAL_WAITING_EVENT,
  buildApprovalDocumentTitle,
  getDesktopApprovalBridge,
  resolveApprovalSessionIds,
  type ApprovalWaitingDetail,
} from '../../../utils/approvalAlert';

type UseApprovalWaitingAlertOptions = {
  pendingPermissionRequests: PendingPermissionRequest[];
  /**
   * Session id used for requests that were received before `session_created`
   * delivered the real id (typically the optimistic `new-session-*` id), so
   * the sidebar can badge the row the user actually sees.
   */
  fallbackSessionId?: string | null;
  /** Localized "⚠ Waiting for approval" label for the window title. */
  waitingLabel: string;
};

/**
 * Observes the pending tool-approval queue of the viewed session and raises
 * system-level reminders while the PilotDeck window is in the background:
 *
 *  - dispatches `pilotdeck:approval-waiting` so the app shell can badge the
 *    session in the sidebar;
 *  - prefixes the window title with the localized waiting label;
 *  - through the Electron bridge, asks the main process for a native toast
 *    and a taskbar flash on the idle→waiting transition (only while the
 *    window is unfocused), and clears both when the queue drains.
 */
export function useApprovalWaitingAlert({
  pendingPermissionRequests,
  fallbackSessionId,
  waitingLabel,
}: UseApprovalWaitingAlertOptions): void {
  const count = pendingPermissionRequests.length;
  const previousCountRef = useRef(0);
  const notifiedRef = useRef(false);
  const baseTitleRef = useRef<string | null>(null);
  const fallbackRef = useRef(fallbackSessionId);
  fallbackRef.current = fallbackSessionId;
  const waitingLabelRef = useRef(waitingLabel);
  waitingLabelRef.current = waitingLabel;
  const sessionIdsKey = resolveApprovalSessionIds(pendingPermissionRequests, fallbackSessionId).join('\n');

  useEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = count;

    const detail: ApprovalWaitingDetail = {
      sessionIds: resolveApprovalSessionIds(pendingPermissionRequests, fallbackRef.current),
    };
    window.dispatchEvent(new CustomEvent<ApprovalWaitingDetail>(APPROVAL_WAITING_EVENT, { detail }));

    const bridge = getDesktopApprovalBridge();
    if (bridge) {
      if (count > 0 && previousCount === 0) {
        // Only alert when the user cannot see the in-app banner anyway;
        // a focused window already shows the amber permission banner.
        if (typeof document.hasFocus !== 'function' || !document.hasFocus()) {
          notifiedRef.current = true;
          void Promise.resolve(bridge.notifyApprovalWaiting!({ count })).catch(() => {});
        }
      } else if (count === 0 && previousCount > 0) {
        if (notifiedRef.current) {
          notifiedRef.current = false;
          void Promise.resolve(bridge.clearApprovalWaiting!()).catch(() => {});
        }
      }
    }
    // `pendingPermissionRequests` changes identity on every store update; the
    // serialized session ids keep the event to real membership changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, sessionIdsKey]);

  useEffect(() => {
    if (count > 0) {
      if (baseTitleRef.current === null) {
        baseTitleRef.current = document.title || 'PilotDeck';
      }
      document.title = buildApprovalDocumentTitle(baseTitleRef.current, count, waitingLabelRef.current);
      return;
    }
    if (baseTitleRef.current !== null) {
      document.title = baseTitleRef.current;
      baseTitleRef.current = null;
    }
  }, [count]);

  useEffect(() => () => {
    // Leaving the session (or unmounting the chat view) must not leave a
    // stuck badge, title, flash or toast behind.
    window.dispatchEvent(new CustomEvent<ApprovalWaitingDetail>(APPROVAL_WAITING_EVENT, {
      detail: { sessionIds: [] },
    }));
    if (baseTitleRef.current !== null) {
      document.title = baseTitleRef.current;
      baseTitleRef.current = null;
    }
    const bridge = getDesktopApprovalBridge();
    if (bridge && notifiedRef.current) {
      notifiedRef.current = false;
      void Promise.resolve(bridge.clearApprovalWaiting!()).catch(() => {});
    }
  }, []);
}
