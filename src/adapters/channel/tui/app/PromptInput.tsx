import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function PromptInput({
  value,
  onChange,
  onSubmit,
  isRunning,
  focus,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  isRunning: boolean;
  focus: boolean;
}): React.ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={isRunning || focus ? pilotDeckDarkBlueTheme.brandAccent : pilotDeckDarkBlueTheme.border}
      paddingX={1}
      flexDirection="row"
    >
      <Text color={pilotDeckDarkBlueTheme.brandAccent}>{"> "}</Text>
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Ask PilotDeck... (Tab focus · ⏎ expand · /help)"
          showCursor
          focus={focus}
        />
      </Box>
    </Box>
  );
}
