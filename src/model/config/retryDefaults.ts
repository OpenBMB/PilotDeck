// Browser-safe defaults shared by the model runtime and its settings editor.
export const MODEL_RETRY_DEFAULTS = Object.freeze({
  requestMaxRetries: 5,
  streamMaxRetries: 5,
  streamIdleTimeoutMs: 600_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: 0.1,
});
