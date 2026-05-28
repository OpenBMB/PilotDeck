import type { GatewayEvent } from "../../../gateway/index.js";

export function renderCliEvent(event: GatewayEvent): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return `[thinking] ${event.text}`;
    case "tool_call_started":
      return `\n[tool:${event.name}] started${event.argsPreview ? ` ${event.argsPreview}` : ""}\n`;
    case "tool_call_finished":
      return `[tool:${event.toolCallId}] ${event.ok ? "ok" : "error"}${event.resultPreview ? ` ${event.resultPreview}` : ""}\n`;
    case "permission_request":
      return `[permission] ${event.toolName} requires approval (${event.requestId})\n`;
    case "structured_output":
      return `\n[structured_output] ${JSON.stringify(event.payload)}\n`;
    case "plan_mode_changed":
      return `\n[mode] ${event.mode}\n`;
    case "error":
      return `\n[error:${event.code ?? "gateway_error"}] ${event.message}\n`;
    default:
      return undefined;
  }
}
