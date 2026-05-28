import React from "react";
import { Box, Text, useStdout } from "ink";
import type { TuiMessage } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";
import { truncateForDisplay } from "./truncate.js";
import { formatToolSummary } from "./formatToolSummary.js";

function formatCharCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

export function MessageResponse({
  message,
  focused = false,
}: {
  message: TuiMessage;
  focused?: boolean;
}): React.ReactNode {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>{"❯ "}</Text>
          <Text color={pilotDeckDarkBlueTheme.brandAccent}>{message.text.trimEnd()}</Text>
        </Box>
      </Box>
    );
  }

  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginTop={0} paddingLeft={2}>
        {message.thinking && message.thinking.length > 0 && (
          <Text dimColor italic>
            {"∴ Thinking"} ({formatCharCount(message.thinking.length)})
          </Text>
        )}
        {message.text.trim().length > 0 && (
          <Text color={pilotDeckDarkBlueTheme.text}>{message.text.trim()}</Text>
        )}
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="row" paddingLeft={2}>
        <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>{"ℹ "}{message.text}</Text>
      </Box>
    );
  }

  if (message.role === "error") {
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text color={pilotDeckDarkBlueTheme.subtle}>  ⎿  </Text>
        <Box flexGrow={1}>
          <Text color={pilotDeckDarkBlueTheme.error}>{message.text.trim()}</Text>
        </Box>
      </Box>
    );
  }

  return <ToolMessageResponse message={message} focused={focused} />;
}

function ToolMessageResponse({
  message,
  focused,
}: {
  message: Extract<TuiMessage, { role: "tool" }>;
  focused: boolean;
}): React.ReactNode {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const color = message.ok === false
    ? pilotDeckDarkBlueTheme.error
    : pilotDeckDarkBlueTheme.success;

  const gutter = focused ? "  ▸  " : "  ⎿  ";
  const gutterColor = focused
    ? pilotDeckDarkBlueTheme.brandAccent
    : pilotDeckDarkBlueTheme.subtle;

  let content: string;
  let showHint = false;

  if (message.expanded && (message.fullText || message.text)) {
    content = (message.fullText ?? message.text).trimEnd();
  } else if (!message.lineCount || message.lineCount <= 4) {
    content = truncateForDisplay(message.text, columns - 6);
  } else {
    content = formatToolSummary(
      message.toolName ?? "tool",
      undefined,
      message.lineCount,
      0,
      message.ok !== false,
      message.text,
    );
    showHint = true;
  }

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={gutterColor}>{gutter}</Text>
      <Box flexGrow={1}>
        <Text color={color}>{content}</Text>
        {showHint && <Text dimColor>  ⏎</Text>}
      </Box>
    </Box>
  );
}
