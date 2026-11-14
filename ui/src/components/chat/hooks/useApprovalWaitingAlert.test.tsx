// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_WAITING_EVENT, type ApprovalWaitingDetail } from '../../../utils/approvalAlert';
import { useApprovalWaitingAlert } from './useApprovalWaitingAlert';

const notifyApprovalWaiting = vi.fn<(detail: { count: number }) => Promise<void>>();
const clearApprovalWaiting = vi.fn<() => Promise<void>>();

const waitingLabel = '⚠ Waiting for approval';
let fallbackSessionId: string | null = null;

function Harness({ count, sessionIds }: { count: number; sessionIds?: (string | null)[] }) {
  const requests = Array.from({ length: count }, (_, index) => ({
    sessionId: sessionIds ? sessionIds[index] ?? null : `session-${index + 1}`,
  }));
  useApprovalWaitingAlert({
    pendingPermissionRequests: requests as never[],
    fallbackSessionId,
    waitingLabel,
  });
  return null;
}

function lastDetail(): ApprovalWaitingDetail {
  const events = recordedEvents();
  const last = events[events.length - 1];
  expect(last).toBeDefined();
  return last;
}

function recordedEvents(): ApprovalWaitingDetail[] {
  return (window.__approvalTestEvents ?? []).slice();
}

declare global {
  interface Window {
    __approvalTestEvents?: ApprovalWaitingDetail[];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'pilotdeckDesktop', {
    configurable: true,
    value: { notifyApprovalWaiting, clearApprovalWaiting },
  });
  window.__approvalTestEvents = [];
  window.addEventListener(APPROVAL_WAITING_EVENT, (event) => {
    window.__approvalTestEvents!.push((event as CustomEvent<ApprovalWaitingDetail>).detail);
  });
  document.title = 'PilotDeck';
  // jsdom reports a focused document by default.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  delete window.__approvalTestEvents;
  vi.restoreAllMocks();
});

describe('useApprovalWaitingAlert', () => {
  it('badges the session and updates the title while waiting, without notifying a focused window', () => {
    const view = render(<Harness count={0} />);
    expect(recordedEvents()).toEqual([{ sessionIds: [] }]);
    expect(document.title).toBe('PilotDeck');

    act(() => view.rerender(<Harness count={1} />));

    // A focused window shows the in-app banner, so the desktop toast/flash is skipped.
    expect(notifyApprovalWaiting).not.toHaveBeenCalled();
    expect(document.title).toBe('⚠ Waiting for approval — PilotDeck');
    expect(lastDetail()).toEqual({ sessionIds: ['session-1'] });
  });

  it('notifies the desktop bridge on the idle→waiting transition when the window is unfocused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const view = render(<Harness count={0} />);

    act(() => view.rerender(<Harness count={2} />));

    expect(notifyApprovalWaiting).toHaveBeenCalledTimes(1);
    expect(notifyApprovalWaiting).toHaveBeenCalledWith({ count: 2 });
    expect(document.title).toBe('⚠ Waiting for approval (2) — PilotDeck');
    expect(lastDetail()).toEqual({ sessionIds: ['session-1', 'session-2'] });
  });

  it('clears the desktop alert, restores the title and empties the badge when the queue drains', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const view = render(<Harness count={0} />);
    act(() => view.rerender(<Harness count={1} />));
    expect(notifyApprovalWaiting).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('⚠ Waiting for approval — PilotDeck');

    act(() => view.rerender(<Harness count={0} />));

    expect(clearApprovalWaiting).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('PilotDeck');
    expect(lastDetail()).toEqual({ sessionIds: [] });
  });

  it('does not clear the desktop alert when it never notified (window stayed focused)', () => {
    const view = render(<Harness count={0} />);
    act(() => view.rerender(<Harness count={1} />));
    act(() => view.rerender(<Harness count={0} />));

    expect(notifyApprovalWaiting).not.toHaveBeenCalled();
    expect(clearApprovalWaiting).not.toHaveBeenCalled();
    expect(document.title).toBe('PilotDeck');
    expect(lastDetail()).toEqual({ sessionIds: [] });
  });

  it('falls back to the optimistic session id for requests without a session id', () => {
    fallbackSessionId = 'new-session-abc';
    const view = render(<Harness count={1} sessionIds={[null]} />);
    expect(lastDetail()).toEqual({ sessionIds: ['new-session-abc'] });

    fallbackSessionId = null;
    act(() => view.rerender(<Harness count={1} sessionIds={['real-session']} />));
    expect(lastDetail()).toEqual({ sessionIds: ['real-session'] });
  });

  it('restores title, badge and desktop alert on unmount mid-waiting', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const view = render(<Harness count={0} />);
    act(() => view.rerender(<Harness count={1} />));
    expect(document.title).toBe('⚠ Waiting for approval — PilotDeck');
    expect(notifyApprovalWaiting).toHaveBeenCalledTimes(1);

    act(() => view.unmount());

    expect(document.title).toBe('PilotDeck');
    expect(clearApprovalWaiting).toHaveBeenCalledTimes(1);
    expect(lastDetail()).toEqual({ sessionIds: [] });
  });

  it('tolerates a missing desktop bridge (plain web build)', () => {
    const desktop = window.pilotdeckDesktop;
    delete window.pilotdeckDesktop;
    try {
      const view = render(<Harness count={0} />);
      act(() => view.rerender(<Harness count={1} />));
      act(() => view.rerender(<Harness count={0} />));
      expect(document.title).toBe('PilotDeck');
      expect(lastDetail()).toEqual({ sessionIds: [] });
    } finally {
      window.pilotdeckDesktop = desktop;
    }
  });
});
