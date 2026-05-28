import type { GatewayEvent } from "../../../gateway/index.js";

export function renderSmsEvent(event: GatewayEvent): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return `\n[${event.name} running]\n`;
    case "tool_call_finished":
      return `\n[${event.toolName ?? event.toolCallId} ${event.ok ? "done" : "failed"}]\n`;
    case "error":
      return `\nError: ${event.message}\n`;
    default:
      return undefined;
  }
}
