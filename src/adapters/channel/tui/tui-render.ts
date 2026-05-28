import type { GatewayEvent } from "../../../gateway/index.js";

export type TuiRenderState = {
  transcript: string[];
  activeTools: Record<string, string>;
  errors: string[];
};

export function createTuiRenderState(): TuiRenderState {
  return { transcript: [], activeTools: {}, errors: [] };
}

export function applyTuiEvent(state: TuiRenderState, event: GatewayEvent): TuiRenderState {
  switch (event.type) {
    case "assistant_text_delta":
      state.transcript.push(event.text);
      break;
    case "assistant_thinking_delta":
      state.transcript.push(`[thinking] ${event.text}`);
      break;
    case "tool_call_started":
      state.activeTools[event.toolCallId] = event.name;
      break;
    case "tool_call_finished":
      delete state.activeTools[event.toolCallId];
      state.transcript.push(`[tool:${event.toolCallId}] ${event.ok ? "ok" : "error"}`);
      break;
    case "error":
      state.errors.push(event.message);
      break;
  }
  return state;
}
