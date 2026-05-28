import { normalizeAnthropicStreamEvent } from "../providers/anthropic/stream.js";
import { createAnthropicStreamState, type AnthropicStreamState } from "../providers/anthropic/stream.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
  type OpenAIStreamState,
} from "../providers/openai/stream.js";
import type { CanonicalModelEvent, ModelProtocol } from "../protocol/canonical.js";

export type StreamNormalizerState = {
  anthropic: AnthropicStreamState;
  openai: OpenAIStreamState;
};

export function createStreamNormalizerState(): StreamNormalizerState {
  return {
    anthropic: createAnthropicStreamState(),
    openai: createOpenAIStreamState(),
  };
}

export function normalizeStreamEvent(
  protocol: ModelProtocol,
  raw: unknown,
  state: StreamNormalizerState = createStreamNormalizerState(),
): CanonicalModelEvent[] {
  if (protocol === "anthropic") {
    return normalizeAnthropicStreamEvent(raw, state.anthropic);
  }

  return normalizeOpenAIStreamEvent(raw, state.openai);
}
