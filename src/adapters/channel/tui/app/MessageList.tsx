import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { MessageResponse } from "./MessageResponse.js";
import { WelcomeCard } from "./WelcomeCard.js";
import type { TuiAppState, TuiMessage } from "./types.js";
import { groupConsecutiveTools, type DisplayItem } from "./groupConsecutiveTools.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function MessageList({
  state,
  rows = 18,
  model,
  cwd,
  serverUrl,
}: {
  state: TuiAppState;
  rows?: number;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const renderable = state.messages.filter(
    (message) => !(message.role === "assistant" && message.text.trim().length === 0 && !message.thinking),
  );

  const displayItems = useMemo(() => groupConsecutiveTools(renderable), [renderable]);

  if (displayItems.length === 0) {
    const connection = state.connection === "remote" ? (serverUrl ? `server ${serverUrl}` : "server connected") : "local in-process";
    return (
      <Box flexDirection="column" height={rows} justifyContent="center">
        <WelcomeCard model={model} cwd={cwd} connection={connection} />
      </Box>
    );
  }

  const { scrollOffset, focusedIndex } = state;
  const total = displayItems.length;

  const end = Math.max(0, total - scrollOffset);
  const start = Math.max(0, end - Math.max(1, rows - 1));
  const visible = displayItems.slice(start, end);

  const hasMore = scrollOffset > 0;

  return (
    <Box flexDirection="column" height={rows} paddingX={1} overflow="hidden">
      {start > 0 && (
        <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>
          ↑ {start} more message{start > 1 ? "s" : ""} above (PageUp to scroll)
        </Text>
      )}
      {visible.map((item, vi) => (
        <DisplayItemView key={start + vi} item={item} focusedIndex={focusedIndex} />
      ))}
      {hasMore && (
        <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>
          ↓ {scrollOffset} below — PageDown to scroll back
        </Text>
      )}
    </Box>
  );
}

function DisplayItemView({
  item,
  focusedIndex,
}: {
  item: DisplayItem;
  focusedIndex: number | null;
}): React.ReactNode {
  if (item.type === "single") {
    return (
      <MessageResponse
        message={item.message}
        focused={focusedIndex === item.index}
      />
    );
  }

  const isFocused =
    focusedIndex !== null &&
    focusedIndex >= item.startIndex &&
    focusedIndex < item.startIndex + item.messages.length;

  if (item.expanded || isFocused) {
    return (
      <>
        <Text dimColor>
          {"  "}┌ {item.toolName} × {item.messages.length}
        </Text>
        {item.messages.map((msg, i) => (
          <MessageResponse
            key={item.startIndex + i}
            message={msg}
            focused={focusedIndex === item.startIndex + i}
          />
        ))}
        <Text dimColor>{"  "}└</Text>
      </>
    );
  }

  const okCount = item.messages.filter((m) => m.role === "tool" && m.ok !== false).length;
  const errCount = item.messages.length - okCount;

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={pilotDeckDarkBlueTheme.subtle}>{"  ⎿  "}</Text>
      <Text dimColor>
        {item.toolName} × {item.messages.length}
        {errCount > 0 ? ` (${errCount} error${errCount > 1 ? "s" : ""})` : ""}
        {"  "}Tab to expand
      </Text>
    </Box>
  );
}
