import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function ToolOutputViewer({
  content,
  title,
  onClose,
}: {
  content: string;
  title: string;
  onClose: () => void;
}): React.ReactNode {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const viewport = Math.max(5, termRows - 4);

  const lines = useMemo(() => content.split("\n"), [content]);
  const maxOffset = Math.max(0, lines.length - viewport);
  const [offset, setOffset] = useState(0);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onClose();
      return;
    }
    if (input === "j" || key.downArrow) {
      setOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + viewport));
      return;
    }
    if (key.pageUp) {
      setOffset((o) => Math.max(0, o - viewport));
      return;
    }
    if (input === "G") {
      setOffset(maxOffset);
      return;
    }
    if (input === "g") {
      setOffset(0);
      return;
    }
  });

  const visibleLines = lines.slice(offset, offset + viewport);
  const endLine = Math.min(offset + viewport, lines.length);

  return (
    <Box flexDirection="column" height={termRows}>
      <Box borderStyle="single" borderColor={pilotDeckDarkBlueTheme.border ?? pilotDeckDarkBlueTheme.subtle}>
        <Text bold color={pilotDeckDarkBlueTheme.brand}>
          {" "}{title}{" "}
        </Text>
        <Text dimColor> j/k PgUp/Dn g/G q:close </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleLines.map((line, i) => (
          <Text key={offset + i} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {" "}Line {offset + 1}-{endLine} of {lines.length}{" "}
      </Text>
    </Box>
  );
}
