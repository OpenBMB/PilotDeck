import type { GatewaySessionInfo } from "../../../../gateway/index.js";

export type SidebarRowKind = "header" | "session";

export type SidebarRow =
  | { kind: "header"; groupKey: string; label: string; count: number; collapsed: boolean }
  | { kind: "session"; session: GatewaySessionInfo; groupKey: string };

export type SessionGroup = {
  groupKey: string;
  label: string;
  sessions: GatewaySessionInfo[];
};

export function groupSessionsByProject(sessions: GatewaySessionInfo[]): SessionGroup[] {
  const map = new Map<string, GatewaySessionInfo[]>();
  for (const s of sessions) {
    const key = s.cwd ?? "(unknown)";
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  const groups: SessionGroup[] = [];
  for (const [key, list] of map) {
    const parts = key.split("/");
    const label = parts[parts.length - 1] ?? key;
    groups.push({ groupKey: key, label, sessions: list });
  }
  groups.sort((a, b) => {
    const aTime = Math.max(...a.sessions.map((s) => s.lastModified ?? 0));
    const bTime = Math.max(...b.sessions.map((s) => s.lastModified ?? 0));
    return bTime - aTime;
  });
  return groups;
}

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  done: "Done",
  error: "Error",
  background: "Background",
};

export function groupSessionsByStatus(sessions: GatewaySessionInfo[]): SessionGroup[] {
  const map = new Map<string, GatewaySessionInfo[]>();
  for (const s of sessions) {
    const key = s.tag ?? "idle";
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  const order = ["running", "waiting", "background", "idle", "done", "error"];
  const groups: SessionGroup[] = [];
  for (const [key, list] of map) {
    groups.push({
      groupKey: `status:${key}`,
      label: STATUS_LABELS[key] ?? key,
      sessions: list,
    });
  }
  groups.sort((a, b) => {
    const ak = a.groupKey.replace("status:", "");
    const bk = b.groupKey.replace("status:", "");
    return (order.indexOf(ak) === -1 ? 99 : order.indexOf(ak)) - (order.indexOf(bk) === -1 ? 99 : order.indexOf(bk));
  });
  return groups;
}

export function groupSessions(sessions: GatewaySessionInfo[], by: "project" | "status"): SessionGroup[] {
  return by === "project" ? groupSessionsByProject(sessions) : groupSessionsByStatus(sessions);
}

export function computeSmartCollapse(
  groups: SessionGroup[],
  activeSessionKey: string,
): Set<string> {
  if (groups.length <= 1) return new Set();
  const collapsed = new Set<string>();
  for (const g of groups) {
    const hasActive = g.sessions.some(
      (s) => (s.sessionKey ?? s.sessionId) === activeSessionKey,
    );
    if (!hasActive) collapsed.add(g.groupKey);
  }
  return collapsed;
}

export function flattenSidebarRows(
  groups: SessionGroup[],
  collapsed: Set<string>,
): SidebarRow[] {
  if (groups.length === 1) {
    return groups[0]!.sessions.map((s) => ({
      kind: "session" as const,
      session: s,
      groupKey: groups[0]!.groupKey,
    }));
  }
  const rows: SidebarRow[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.groupKey);
    rows.push({
      kind: "header",
      groupKey: g.groupKey,
      label: g.label,
      count: g.sessions.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const s of g.sessions) {
        rows.push({ kind: "session", session: s, groupKey: g.groupKey });
      }
    }
  }
  return rows;
}

const STATUS_ICONS: Record<string, string> = {
  running: "✻",
  waiting: "✽",
  idle: "∙",
  done: "✓",
  error: "✗",
  background: "■",
};

export function sessionStatusIcon(session: GatewaySessionInfo): string {
  const tag = session.tag ?? "idle";
  return STATUS_ICONS[tag] ?? "∙";
}

export function sessionDisplayTitle(session: GatewaySessionInfo, maxLen: number): string {
  const raw = session.customTitle || session.aiTitle || session.firstPrompt || session.summary || session.sessionId;
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen - 1) + "…";
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
