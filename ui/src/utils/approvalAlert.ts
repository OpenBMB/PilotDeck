/**
 * Approval-waiting alert plumbing shared by the chat view (producer) and the
 * app shell (sidebar consumer). A session waiting for tool approval must stay
 * visible even when the PilotDeck window lost focus, otherwise desktop users
 * only find out by switching back (see issue #691).
 *
 * Three channels are driven from one place:
 *  - a DOM CustomEvent so any surface (sidebar, shell) can badge the session;
 *  - `document.title` so the taskbar/alt-tab entry shows the waiting state;
 *  - the optional Electron bridge for a native toast + taskbar flash.
 */

export const APPROVAL_WAITING_EVENT = 'pilotdeck:approval-waiting';

export type ApprovalWaitingDetail = {
  sessionIds: string[];
};

type PendingApprovalLike = {
  sessionId?: string | null;
};

export type DesktopApprovalBridge = {
  notifyApprovalWaiting?: (detail: { count: number }) => Promise<void> | void;
  clearApprovalWaiting?: () => Promise<void> | void;
};

/**
 * Returns the desktop bridge only when it can express the full alert cycle,
 * so partially-missing bridges (older desktop builds, plain web) degrade to
 * the DOM-event/title channels.
 */
export function getDesktopApprovalBridge(
  desktop: unknown = typeof window === 'undefined' ? undefined : window.pilotdeckDesktop,
): DesktopApprovalBridge | null {
  if (!desktop || typeof desktop !== 'object') return null;
  const candidate = desktop as DesktopApprovalBridge;
  if (typeof candidate.notifyApprovalWaiting !== 'function') return null;
  if (typeof candidate.clearApprovalWaiting !== 'function') return null;
  return candidate;
}

/**
 * Distinct session ids that currently wait for approval. Requests that have
 * not learned their session id yet (sent before `session_created`) fall back
 * to the caller-provided id so the optimistic sidebar row still badges.
 */
export function resolveApprovalSessionIds(
  requests: PendingApprovalLike[],
  fallbackSessionId?: string | null,
): string[] {
  const ids = new Set<string>();
  let usedFallback = false;
  for (const request of requests) {
    const id = typeof request?.sessionId === 'string' && request.sessionId
      ? request.sessionId
      : null;
    if (id) {
      ids.add(id);
    } else if (fallbackSessionId && !usedFallback) {
      ids.add(fallbackSessionId);
      usedFallback = true;
    }
  }
  if (ids.size === 0 && fallbackSessionId && requests.length > 0) {
    ids.add(fallbackSessionId);
  }
  return [...ids];
}

/**
 * Window title while a session waits for approval. The count suffix only
 * appears when more than one decision is pending to keep the common case
 * short in the taskbar.
 */
export function buildApprovalDocumentTitle(baseTitle: string, count: number, label: string): string {
  if (count <= 0) return baseTitle;
  const safeBase = baseTitle.trim() || 'PilotDeck';
  const countSuffix = count > 1 ? ` (${count})` : '';
  return `${label}${countSuffix} — ${safeBase}`;
}
