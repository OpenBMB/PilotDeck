import { normalizeAnthropicStreamEvent } from "../providers/anthropic/stream.js";
import { createAnthropicStreamState, type AnthropicStreamState } from "../providers/anthropic/stream.js";
import {
  createGoogleStreamState,
  normalizeGoogleStreamEvent,
  type GoogleStreamState,
} from "../providers/google/stream.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
  type OpenAIStreamState,
} from "../providers/openai/stream.js";
import type { CanonicalModelEvent, ModelProtocol } from "../protocol/canonical.js";

export type StreamNormalizerState = {
  anthropic?: AnthropicStreamState;
  google?: GoogleStreamState;
  openai?: OpenAIStreamState;
};

export function createStreamNormalizerState(protocol: ModelProtocol): StreamNormalizerState {
  if (protocol === "anthropic") {
    return { anthropic: createAnthropicStreamState() };
  }
  if (protocol === "google") {
    return { google: createGoogleStreamState() };
  }
  return { openai: createOpenAIStreamState() };
}

export function normalizeStreamEvent(
  protocol: ModelProtocol,
  raw: unknown,
  state: StreamNormalizerState,
): CanonicalModelEvent[] {
  if (protocol === "anthropic") {
    state.anthropic ??= createAnthropicStreamState();
    return normalizeAnthropicStreamEvent(raw, state.anthropic);
  }

  if (protocol === "google") {
    state.google ??= createGoogleStreamState();
    return normalizeGoogleStreamEvent(raw, state.google);
  }

  state.openai ??= createOpenAIStreamState();
  return normalizeOpenAIStreamEvent(raw, state.openai);
}
