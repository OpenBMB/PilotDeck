import type { CanonicalMessage } from "../../model/index.js";

export type ContextMemoryMessage = {
  msgId?: string;
  role: string;
  content: string;
};

export type MemoryRetrieveInput = {
  query: string;
  sessionId: string;
  projectRoot: string;
  recentMessages: CanonicalMessage[];
  signal?: AbortSignal;
};

export type MemoryRetrieveResult = {
  systemContext?: string;
  diagnostics: MemoryDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type MemoryCaptureTurnInput = {
  sessionId: string;
  projectRoot: string;
  messages: CanonicalMessage[];
  errored: boolean;
};

export type MemoryDiagnostic = {
  code: "memory_disabled" | "memory_provider_error" | "memory_context_empty";
  message: string;
  severity: "info" | "warning" | "error";
};

export type MemoryResolver = {
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult>;
  captureTurn(input: MemoryCaptureTurnInput): Promise<void>;
};

export function canonicalMessagesToMemoryMessages(messages: CanonicalMessage[]): ContextMemoryMessage[] {
  return messages.flatMap((message, index) => {
    const entries: Array<Omit<ContextMemoryMessage, "msgId">> = [];
    const pushEntry = (role: string, text: string) => {
      const content = text.trim();
      if (!content) return;
      const previous = entries.at(-1);
      if (previous?.role === role) {
        previous.content = `${previous.content}\n${content}`;
        return;
      }
      entries.push({ role, content });
    };

    for (const block of message.content) {
      if (block.type === "text") {
        pushEntry(message.role, block.text);
      } else if (block.type === "tool_result") {
        pushEntry(
          "tool",
          block.content.map((item) => item.type === "text" ? item.text : `[${item.type}]`).join("\n"),
        );
      } else if (block.type === "tool_result_reference") {
        pushEntry("tool", block.preview);
      }
    }

    return entries.map((entry, entryIndex) => ({
      msgId: entries.length === 1 ? `message-${index}` : `message-${index}:${entryIndex}`,
      role: entry.role,
      content: entry.content,
    }));
  });
}
