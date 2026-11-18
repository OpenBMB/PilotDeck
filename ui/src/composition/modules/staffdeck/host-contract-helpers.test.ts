// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceEnterpriseCapabilityCatalogChange, subscribeEnterpriseCapabilityCatalogRefresh, copyTextToClipboard, parseHandoffAssigneeValue, formatHandoffAssigneeValue, normalizeCapabilityScope, isTeamScope, readEmployeeScope, persistSharedAgentScope, clearSharedAgentScope } from './host-contract-helpers';
import { createCopyContext } from '../../../../plugins/staffdeck-shared/vendor/copy-scope';
import { staffDeckCopyClient } from './clients';

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;
afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand });
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('source scope and handoff contracts', () => {
  it('retains team scope storage while employee-facing reads correctly return no employee', async () => {
    persistSharedAgentScope('team:real-team');
    expect(readEmployeeScope()).toBe('');
    expect(isTeamScope('team:')).toBe(false);
    expect(isTeamScope('team:real-team')).toBe(true);
    const context = createCopyContext();
    vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue([{ id: 'target', tenant_id: 'tenant-real', copy_target: true, is_overall: false }] as never);
    await context.loadDirectory();
    expect(context.readScope()).toBe('');
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBe('team:real-team');
    clearSharedAgentScope();
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBeNull();
  });
  it('keeps source trim/web/null semantics without changing handoff identities', () => {
    expect(parseHandoffAssigneeValue('')).toEqual({ userId: '', channel: null });
    expect(parseHandoffAssigneeValue('  user  ')).toEqual({ userId: 'user', channel: 'web' });
    expect(parseHandoffAssigneeValue(' user :: feishu ')).toEqual({ userId: 'user', channel: 'feishu' });
    expect(parseHandoffAssigneeValue(' user:: ')).toEqual({ userId: 'user::', channel: 'web' });
    expect(formatHandoffAssigneeValue('user', 'web')).toBe('user');
    expect(formatHandoffAssigneeValue(null, 'feishu')).toBe('');
    expect(formatHandoffAssigneeValue('user', 'feishu')).toBe('user::feishu');
    expect(normalizeCapabilityScope('sop-specific')).toBe('sop_specific');
    expect(normalizeCapabilityScope('sop_specific')).toBe('sop_specific');
    expect(normalizeCapabilityScope(null)).toBe('general');
  });
});

describe('source catalog subscription lifecycle', () => {
  it('refreshes on real catalog/focus/pageshow/visible events and removes only its own subscription', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = subscribeEnterpriseCapabilityCatalogRefresh(first);
    const disposeSecond = subscribeEnterpriseCapabilityCatalogRefresh(second);
    try {
      announceEnterpriseCapabilityCatalogChange({ resourceType: 'sop', agentId: 'target' });
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(first).toHaveBeenCalledTimes(3);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(first).toHaveBeenCalledTimes(4);
      disposeFirst();
      announceEnterpriseCapabilityCatalogChange({ resourceType: 'knowledge' });
      expect(first).toHaveBeenCalledTimes(4);
      expect(second).toHaveBeenCalledTimes(5);
    } finally { disposeFirst(); disposeSecond(); }
  });
});

describe('source clipboard fallback', () => {
  it('falls back after writeText rejection, supplies copy payload, and restores focus and selection', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const setData = vi.fn();
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData } });
      document.dispatchEvent(event);
      return true;
    }) });
    const button = document.createElement('button');
    const text = document.createElement('span');
    text.textContent = 'selected text';
    document.body.append(button, text);
    button.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(document.getSelection()!.toString()).toBe('selected text');
    await copyTextToClipboard('copied payload');
    expect(writeText).toHaveBeenCalledWith('copied payload');
    expect(setData).toHaveBeenCalledWith('text/plain', 'copied payload');
    expect(document.activeElement).toBe(button);
    expect(document.getSelection()!.toString()).toBe('selected text');
    expect(document.querySelector('textarea')).toBeNull();
  });
  it('rejects when execCommand reports success without an actual copy event and cleans up', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) });
    await expect(copyTextToClipboard('payload')).rejects.toThrow('Clipboard access is unavailable');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
