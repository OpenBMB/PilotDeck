import React from "react";
import { Box, Text } from "ink";
import type { TuiAppState } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";
import { CondensedLogo } from "./PilotDeckLogo.js";

export function StatusLine(props: {
  state: TuiAppState;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const connection =
    props.state.connection === "remote" ? `server ${props.serverUrl ?? "connected"}` : "local in-process";
  return (
    <Box borderStyle="single" borderColor={pilotDeckDarkBlueTheme.border} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <CondensedLogo />
        <Text color={pilotDeckDarkBlueTheme.subtle}>v0.1.0</Text>
      </Box>
      <Text color={pilotDeckDarkBlueTheme.subtle}>
        {props.model ?? "model"} · {props.state.mode} · {shortenPath(props.cwd)} · {connection}
      </Text>
    </Box>
  );
}

function shortenPath(path: string): string {
  if (path.length <= 42) {
    return path;
  }
  return `...${path.slice(-39)}`;
}
