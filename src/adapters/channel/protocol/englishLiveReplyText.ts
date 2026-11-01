import type { GatewayEvent } from "../../../gateway/index.js";
import type { ImLiveReplyActivity, ImLiveReplyControllerOptions } from "./ImLiveReplyController.js";

/**
 * English wording for live replies on international channels (Slack,
 * Telegram). The controller defaults stay Chinese for the domestic channels.
 */
export const ENGLISH_LIVE_REPLY_TEXT = {
  formatActivity: (activity: Omit<ImLiveReplyActivity, "text">): string => {
    const base = activity.kind === "tool"
      ? "Running a tool…"
      : activity.kind === "subagent"
        ? "Working on a subtask…"
        : "Thinking…";
    return activity.elapsedMs < 10_000 ? base : `${base} (${Math.round(activity.elapsedMs / 1000)}s)`;
  },
  formatToolError: (event: GatewayEvent & { type: "tool_call_finished"; ok: false }): string =>
    `\n⚠️ ${event.toolName ?? event.toolCallId} failed\n`,
  activityOnlyFinalText: "Done, but there was no visible reply.",
  timeoutFinalText: "This took too long and was stopped. Please resend or try again later.",
  abortFinalText: "Stopped. Please resend or try again later.",
} satisfies Partial<ImLiveReplyControllerOptions>;

export const ENGLISH_NEW_SESSION_TEXT = "Started a new session.";
export const ENGLISH_SUBMIT_FAILED_TEXT = "Failed to process this message. Please retry.";
