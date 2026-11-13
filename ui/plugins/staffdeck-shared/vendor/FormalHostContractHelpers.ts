// Source helper extraction from StaffDeck 01fb898ecd7c0bf2b5a6991577f2f5a7e79bedb1.
// Adopted from adapter 3fa7b145; native adapters and shared Hosts re-export this source.

// Source: frontend-enterprise/src/lib/agent-scope-storage.ts
export const ENTERPRISE_AGENT_STORAGE_KEY = 'ultrarag_enterprise_agent_scope';
export const SELECTED_AGENT_STORAGE_KEY = ENTERPRISE_AGENT_STORAGE_KEY;
export const SESSION_FILTER_STORAGE_PREFIX = 'skill_agent_session_filter';

export function sessionFilterStorageKey(userId: string): string {
  return `${SESSION_FILTER_STORAGE_PREFIX}:${userId || 'anonymous'}`;
}

export function persistSharedAgentScope(agentId: string, userId?: string): void {
  void userId;
  if (!agentId) return;
  window.localStorage.setItem(ENTERPRISE_AGENT_STORAGE_KEY, agentId);
}

export function clearSharedAgentScope(userId?: string): void {
  void userId;
  window.localStorage.removeItem(ENTERPRISE_AGENT_STORAGE_KEY);
}

// Team scopes share the same storage slot as employee agent ids, prefixed so
// readers can tell "current team" apart from "current employee".
export const TEAM_SCOPE_PREFIX = 'team:';

export function toTeamScope(teamId: string): string {
  return teamId ? `${TEAM_SCOPE_PREFIX}${teamId}` : '';
}

export function isTeamScope(value: string | null | undefined): boolean {
  return typeof value === 'string'
    && value.startsWith(TEAM_SCOPE_PREFIX)
    && value.length > TEAM_SCOPE_PREFIX.length;
}

export function teamIdFromScope(value: string | null | undefined): string {
  return isTeamScope(value) ? String(value).slice(TEAM_SCOPE_PREFIX.length) : '';
}

/** 读取共享作用域；团队作用域对员工向页面视为"未选员工"，返回空串。 */
export function readEmployeeScope(): string {
  const raw = window.localStorage.getItem(ENTERPRISE_AGENT_STORAGE_KEY) || '';
  return isTeamScope(raw) ? '' : raw;
}

export function emitAgentScopeChange(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent('ultrarag-enterprise-agent-scope-change', {
      detail: { agentId },
    }),
  );
}

// Source: frontend-enterprise/src/lib/capability-catalog-events.ts
export const ENTERPRISE_CAPABILITY_CATALOG_CHANGED_EVENT =
  'ultrarag-enterprise-capability-catalog-changed';

export type EnterpriseCapabilityResourceType = 'tool' | 'skill' | 'knowledge' | 'sop';

export type EnterpriseCapabilityCatalogChange = {
  resourceType: EnterpriseCapabilityResourceType;
  agentId?: string;
};

export function announceEnterpriseCapabilityCatalogChange(
  detail: EnterpriseCapabilityCatalogChange,
) {
  window.dispatchEvent(
    new CustomEvent<EnterpriseCapabilityCatalogChange>(
      ENTERPRISE_CAPABILITY_CATALOG_CHANGED_EVENT,
      { detail },
    ),
  );
}

export function subscribeEnterpriseCapabilityCatalogRefresh(listener: () => void) {
  const onFocus = () => listener();
  const onPageShow = () => listener();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') listener();
  };
  const onCatalogChange = () => listener();

  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener(ENTERPRISE_CAPABILITY_CATALOG_CHANGED_EVENT, onCatalogChange);

  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener(ENTERPRISE_CAPABILITY_CATALOG_CHANGED_EVENT, onCatalogChange);
  };
}

// Source: frontend-enterprise/src/lib/handoff-assignee.ts
const HANDOFF_ASSIGNEE_SEPARATOR = '::';

/**
 * 处理人下拉框取值规则:
 * - 空串表示未配置/未指定;
 * - 纯 user_id 表示网页端投递;
 * - `${user_id}::${channel}` 表示按成员已绑定的渠道身份投递(如飞书)。
 */
export function formatHandoffAssigneeValue(
  userId?: string | null,
  channel?: string | null,
): string {
  if (!userId) return '';
  return channel && channel !== 'web'
    ? `${userId}${HANDOFF_ASSIGNEE_SEPARATOR}${channel}`
    : userId;
}

export function parseHandoffAssigneeValue(value: string): {
  userId: string;
  channel: string | null;
} {
  const trimmed = value.trim();
  if (!trimmed) return { userId: '', channel: null };
  const separatorIndex = trimmed.indexOf(HANDOFF_ASSIGNEE_SEPARATOR);
  if (separatorIndex < 0) {
    return { userId: trimmed, channel: 'web' };
  }
  const userId = trimmed.slice(0, separatorIndex).trim();
  const channel = trimmed.slice(separatorIndex + HANDOFF_ASSIGNEE_SEPARATOR.length).trim();
  if (!userId || !channel) {
    return { userId: trimmed, channel: 'web' };
  }
  return { userId, channel };
}

// Source: frontend-enterprise/src/lib/clipboard.ts
function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '0';
  textarea.style.top = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = '0';
  textarea.style.opacity = '0.01';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);

  // Some restricted HTTP browsers return true from execCommand without
  // emitting a real copy operation. Supplying the payload through the copy
  // event improves compatibility and prevents a false-success result.
  let copyEventSeen = false;
  const handleCopy = (event: ClipboardEvent) => {
    copyEventSeen = true;
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  };
  document.addEventListener('copy', handleCopy, true);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy') && copyEventSeen;
  } finally {
    document.removeEventListener('copy', handleCopy, true);
    textarea.remove();
    // Focusing can collapse the restored DOM selection; restore ranges last.
    activeElement?.focus();
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

/** Copies text in browsers, desktop webviews, and non-secure local deployments. */
export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Some desktop webviews expose Clipboard API but reject it due to permissions.
    }
  }

  if (!copyWithSelection(text)) {
    throw new Error('Clipboard access is unavailable');
  }
}

// Source: frontend-enterprise/src/components/CapabilityScopeControl.tsx
export function normalizeCapabilityScope(value: unknown): 'sop_specific' | 'general' {
  return value === 'sop_specific' || value === 'sop-specific' ? 'sop_specific' : 'general';
}
