import type { GatewayEvent } from "../../../gateway/index.js";
import {
  isVisibleFailureStatusDetail,
  visibleStatusMessage,
} from "../../../status/agentStatus.js";

const VISIBLE_FAILURE_STATUS_EVENTS = new Set([
  "model_empty_response_exhausted",
  "max_turns_reached",
  "max_output_recovery_exhausted",
  "model_request_failed",
  "tool_call_recovery_exhausted",
  "tool_error_loop",
  "lifecycle_blocked",
  "turn_failed",
  "turn_timeout",
  "gateway_submit_failed",
  "session_busy",
  "gateway_bridge_error",
  "gateway_stream_ended_without_completion",
  "channel_submit_failed",
  "subagent_failed",
  "content_filter_stop",
  "unknown_finish_reason",
]);

export function renderWebhookEvent(event: GatewayEvent): string | undefined {
  switch (event.type) {
    case "assistant_text_delta":
      return event.text;
    case "assistant_thinking_delta":
      return "";
    case "tool_call_started":
      return `\n[${event.name} running]\n`;
    case "tool_call_finished":
      return `\n[${event.toolName ?? event.toolCallId} ${event.ok ? "done" : "failed"}]\n`;
    case "agent_status":
      if (isVisibleFailureAgentStatus(event)) {
        return `\n⚠️ ${visibleStatusMessage(event.detail, "Agent execution stopped before producing a complete response.")}\n`;
      }
      return undefined;
    case "error":
      return `\nError: ${event.message}\n`;
    default:
      return undefined;
  }
}

function isVisibleFailureAgentStatus(event: GatewayEvent & { type: "agent_status" }): boolean {
  return event.detail?.visible !== false
    && (VISIBLE_FAILURE_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail));
}
