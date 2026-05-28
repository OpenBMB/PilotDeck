import React from "react";
import { Box, Text } from "ink";
import type { GatewaySessionInfo } from "../../../../gateway/index.js";
import {
  flattenSidebarRows,
  relativeTime,
  sessionDisplayTitle,
  sessionStatusIcon,
  type SessionGroup,
  type SidebarRow,
} from "./sidebar-helpers.js";
import { pilotDeckDarkBlueTheme as theme } from "./theme.js";

export const SIDEBAR_WIDTH = 30;
export const MIN_SIDEBAR_COLS = 70;

export type SessionSidebarProps = {
  groups: SessionGroup[];
  collapsed: Set<string>;
  cursorIndex: number;
  activeSessionKey: string;
  maxRows: number;
  groupBy: "project" | "status";
};

export function SessionSidebar({
  groups,
  collapsed,
  cursorIndex,
  activeSessionKey,
  maxRows,
  groupBy,
}: SessionSidebarProps): React.ReactNode {
  const rows = flattenSidebarRows(groups, collapsed);
  const titleWidth = SIDEBAR_WIDTH - 2;

  const visibleRows = rows.slice(0, Math.max(0, maxRows - 2));

  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={0}
      paddingRight={0}
    >
      <Box paddingLeft={1} justifyContent="space-between">
        <Text bold color={theme.brand}>Sessions</Text>
        <Text color={theme.subtle} dimColor>{groupBy === "project" ? "by proj" : "by stat"} </Text>
      </Box>

      {visibleRows.map((row, i) => (
        <SidebarRowView
          key={rowKey(row, i)}
          row={row}
          selected={i === cursorIndex}
          activeSessionKey={activeSessionKey}
          titleWidth={titleWidth}
        />
      ))}

      {rows.length > visibleRows.length ? (
        <Box paddingLeft={1}>
          <Text color={theme.subtle}>+{rows.length - visibleRows.length} more</Text>
        </Box>
      ) : null}

      <Box marginTop={0} paddingLeft={1}>
        <Text color={theme.subtle} dimColor>
          ↑↓ nav  Enter go  ^S group  Esc close
        </Text>
      </Box>
    </Box>
  );
}

function SidebarRowView({
  row,
  selected,
  activeSessionKey,
  titleWidth,
}: {
  row: SidebarRow;
  selected: boolean;
  activeSessionKey: string;
  titleWidth: number;
}): React.ReactNode {
  if (row.kind === "header") {
    const arrow = row.collapsed ? "▸" : "▾";
    const label = `${arrow} ${row.label} (${row.count})`;
    return (
      <Box paddingLeft={1}>
        <Text
          color={selected ? theme.brandAccent : theme.text}
          bold={selected}
          inverse={selected}
        >
          {truncateStr(label, titleWidth)}
        </Text>
      </Box>
    );
  }

  const session = row.session;
  const key = session.sessionKey ?? session.sessionId;
  const isActive = key === activeSessionKey;
  const icon = sessionStatusIcon(session);
  const time = session.lastModified ? relativeTime(session.lastModified) : "";
  const maxTitle = titleWidth - 6 - time.length;
  const title = sessionDisplayTitle(session, Math.max(4, maxTitle));
  const pointer = selected ? ">" : " ";

  return (
    <Box paddingLeft={1}>
      <Text
        color={selected ? theme.brandAccent : isActive ? theme.brandAccent : theme.text}
        bold={selected || isActive}
        inverse={selected}
      >
        {pointer} {icon} {title}
      </Text>
      <Text color={theme.subtle}> {time.padStart(3)}</Text>
    </Box>
  );
}

function rowKey(row: SidebarRow, index: number): string {
  if (row.kind === "header") return `h:${row.groupKey}`;
  return `s:${row.session.sessionKey ?? row.session.sessionId}:${index}`;
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
