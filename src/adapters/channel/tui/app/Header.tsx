import React from "react";
import { Box, Text } from "ink";
import type { TuiAppState } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function Header({
  state,
  model,
  cwd,
  serverUrl,
}: {
  state: TuiAppState;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const connection =
    state.connection === "remote" ? (serverUrl ? `server ${serverUrl}` : "server connected") : "local in-process";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={pilotDeckDarkBlueTheme.brand} bold>
          Pilot
        </Text>
        <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>
          Deck
        </Text>
        <Text color={pilotDeckDarkBlueTheme.brandAccent}> ↗</Text>
        <Text color={pilotDeckDarkBlueTheme.subtle}>{"  "}v0.1.0</Text>
      </Text>
      <Text color={pilotDeckDarkBlueTheme.subtle}>
        {model ?? "model"} · {state.mode} · {shortenPath(cwd)} · {connection}
      </Text>
    </Box>
  );
}

function shortenPath(path: string): string {
  if (path.length <= 60) {
    return path;
  }
  return `...${path.slice(-57)}`;
}
