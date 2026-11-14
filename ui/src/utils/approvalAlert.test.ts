import { describe, expect, it } from 'vitest';
import {
  APPROVAL_WAITING_EVENT,
  buildApprovalDocumentTitle,
  getDesktopApprovalBridge,
  resolveApprovalSessionIds,
} from './approvalAlert';

describe('resolveApprovalSessionIds', () => {
  it('collects distinct session ids in order', () => {
    expect(resolveApprovalSessionIds([
      { sessionId: 'b' },
      { sessionId: 'a' },
      { sessionId: 'b' },
    ])).toEqual(['b', 'a']);
  });

  it('uses the fallback id at most once for requests without a session id', () => {
    expect(resolveApprovalSessionIds([{ sessionId: null }, {}], 'optimistic-1')).toEqual(['optimistic-1']);
  });

  it('ignores the fallback when every request already carries an id', () => {
    expect(resolveApprovalSessionIds([{ sessionId: 'real' }], 'optimistic-1')).toEqual(['real']);
  });

  it('returns empty when there is nothing to resolve', () => {
    expect(resolveApprovalSessionIds([], 'optimistic-1')).toEqual([]);
    expect(resolveApprovalSessionIds([{}])).toEqual([]);
  });
});

describe('buildApprovalDocumentTitle', () => {
  it('restores the base title when nothing is pending', () => {
    expect(buildApprovalDocumentTitle('PilotDeck', 0, '⚠ Waiting')).toBe('PilotDeck');
  });

  it('prefixes the waiting label without a count for a single request', () => {
    expect(buildApprovalDocumentTitle('PilotDeck', 1, '⚠ Waiting')).toBe('⚠ Waiting — PilotDeck');
  });

  it('appends the count for several pending requests', () => {
    expect(buildApprovalDocumentTitle('PilotDeck', 3, '⚠ Waiting')).toBe('⚠ Waiting (3) — PilotDeck');
  });

  it('falls back to the app name for an empty base title', () => {
    expect(buildApprovalDocumentTitle('', 1, '⚠ Waiting')).toBe('⚠ Waiting — PilotDeck');
  });
});

describe('getDesktopApprovalBridge', () => {
  it('accepts a bridge exposing the full alert cycle', () => {
    const bridge = {
      notifyApprovalWaiting: () => {},
      clearApprovalWaiting: () => {},
    };
    expect(getDesktopApprovalBridge(bridge)).toBe(bridge);
  });

  it('rejects missing or partial bridges so the DOM channels degrade gracefully', () => {
    expect(getDesktopApprovalBridge(undefined)).toBeNull();
    expect(getDesktopApprovalBridge(null)).toBeNull();
    expect(getDesktopApprovalBridge('desktop')).toBeNull();
    expect(getDesktopApprovalBridge({ notifyApprovalWaiting: () => {} })).toBeNull();
    expect(getDesktopApprovalBridge({ clearApprovalWaiting: () => {} })).toBeNull();
  });
});

describe('APPROVAL_WAITING_EVENT', () => {
  it('is a stable namespaced event name', () => {
    expect(APPROVAL_WAITING_EVENT).toBe('pilotdeck:approval-waiting');
  });
});
