import React from "react";
import { Box, Text } from "ink";
import { PilotDeckLogo } from "./PilotDeckLogo.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function WelcomeCard({
  model,
  cwd,
  connection,
}: {
  model?: string;
  cwd: string;
  connection: string;
}): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={pilotDeckDarkBlueTheme.border}
      paddingX={2}
      paddingY={1}
      marginX={1}
    >
      <PilotDeckLogo tagline="AI agent runtime · CLI · TUI · Web · Feishu" />
      <Box marginTop={1} flexDirection="column">
        <Row label="model" value={model ?? "model"} />
        <Row label="cwd" value={shortenPath(cwd)} />
        <Row label="connection" value={connection} />
      </Box>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <Text>
      <Text color={pilotDeckDarkBlueTheme.brandAccent}>{label.padEnd(11)}</Text>
      <Text color={pilotDeckDarkBlueTheme.text}>{value}</Text>
    </Text>
  );
}

function shortenPath(path: string): string {
  if (path.length <= 64) {
    return path;
  }
  return `...${path.slice(-61)}`;
}
