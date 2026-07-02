import type { GatewayEvent } from "../../../gateway/index.js";

export function renderWeixinEvent(event: GatewayEvent): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return "";
    case "tool_call_finished":
      if (!event.ok) {
        const name = event.toolName ?? event.toolCallId;
        if (name === "send_attachment") return "";
        return `\n⚠️ ${name} 执行失败\n`;
      }
      return "";
    case "elicitation_request": {
      const lines: string[] = [];
      for (const q of event.questions) {
        if (q.header) lines.push(`**${q.header}**`);
        if (q.question) lines.push(q.question);
        for (let i = 0; i < q.options.length; i++) {
          lines.push(`${i + 1}. ${q.options[i].label}`);
        }
      }
      return lines.length > 0 ? `\n${lines.join("\n")}\n` : "";
    }
    case "error":
      return `\n❌ ${event.message}\n`;
    default:
      return undefined;
  }
}
