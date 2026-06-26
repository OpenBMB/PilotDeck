import React from "react";
import { Box, Text } from "ink";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export type PermissionPromptProps = {
  toolName: string;
  payload: unknown;
  isElicitation?: boolean;
  queueLength?: number;
};

export function PermissionPrompt({ toolName, payload, isElicitation, queueLength }: PermissionPromptProps): React.ReactNode {
  const detail = extractDetail(toolName, payload);
  const preview =
    detail && detail.length > 60 ? `${detail.slice(0, 57)}...` : detail;
  const queueHint = queueLength && queueLength > 1 ? ` (${queueLength} pending)` : "";
  const title = isElicitation ? "Input required" : "Permission required";
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={pilotDeckDarkBlueTheme.warning}
      paddingX={1}
    >
      <Text bold color={pilotDeckDarkBlueTheme.warning}>
        {title}{queueHint}
      </Text>
      <Text>
        <Text bold>{toolName}</Text>
        {preview ? <Text dimColor> — {preview}</Text> : null}
      </Text>
      <Text dimColor>
        {isElicitation
          ? "Type the requested value or option number below · [Esc] Cancel"
          : "[y] Allow once · [a] Allow + remember · [n] Deny · [Esc] Abort turn"}
      </Text>
    </Box>
  );
}

export function extractDetail(toolName: string, payload: unknown): string | null {
  if (typeof payload !== "object" || !payload) return null;
  const record = payload as Record<string, unknown>;
  const fields = record.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    const first = fields[0];
    if (first && typeof first === "object") {
      const label = (first as Record<string, unknown>).label;
      return typeof label === "string" ? label : null;
    }
  }
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0];
    if (first && typeof first === "object") {
      const question = (first as Record<string, unknown>).question;
      return typeof question === "string" ? question : null;
    }
  }

  switch (toolName) {
    case "bash": {
      const cmd = record.command;
      return typeof cmd === "string" ? cmd : null;
    }
    case "write_file":
    case "writeFile":
    case "edit_file":
    case "editFile":
    case "str_replace_editor": {
      const path = record.path ?? record.file_path ?? record.filePath;
      return typeof path === "string" ? path : null;
    }
    case "agent": {
      const desc = record.description ?? record.task ?? record.prompt;
      if (typeof desc === "string") return desc.slice(0, 80);
      return null;
    }
    case "web_search":
    case "webSearch": {
      const query = record.query ?? record.search_term;
      return typeof query === "string" ? query : null;
    }
    case "web_fetch":
    case "webFetch": {
      const url = record.url;
      return typeof url === "string" ? url : null;
    }
    default: {
      const first = Object.values(record).find((v) => typeof v === "string");
      return typeof first === "string" && first.length > 0 ? first.slice(0, 60) : null;
    }
  }
}
