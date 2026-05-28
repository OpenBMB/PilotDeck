import type { ModelCapabilities } from "./capabilities.js";
import type { CanonicalModelError } from "./errors.js";
import type { MultimodalConstraints } from "./multimodal.js";

export type ModelProtocol = "anthropic" | "openai";

export type CanonicalRole = "user" | "assistant";

export type CanonicalTextBlock = {
  type: "text";
  text: string;
};

export type CanonicalThinkingBlock = {
  type: "thinking";
  text: string;
  /**
   * Provider-supplied signature accompanying the thinking block (Anthropic
   * extended-thinking signature_delta). Required for prompt-cache validity
   * when the message is replayed; preserved verbatim.
   */
  signature?: string;
};

export type CanonicalImageBlock = {
  type: "image";
  source: "base64" | "url";
  data: string;
  mimeType: string;
  bytes?: number;
  detail?: "auto" | "low" | "high";
};

export type CanonicalPdfBlock = {
  type: "pdf";
  source: "base64";
  data: string;
  mimeType: "application/pdf";
  bytes: number;
  pages?: number;
};

export type CanonicalAudioBlock = {
  type: "audio";
  source: "base64" | "url";
  data: string;
  mimeType: string;
  durationSeconds?: number;
};

export type CanonicalToolCall = {
  id: string;
  name: string;
  input: unknown;
  raw?: unknown;
};

export type CanonicalToolCallBlock = CanonicalToolCall & {
  type: "tool_call";
};

export type CanonicalToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  content: CanonicalToolResultContentBlock[];
  isError?: boolean;
  raw?: unknown;
};

export type CanonicalToolResultContentBlock =
  | CanonicalTextBlock
  | CanonicalImageBlock
  | CanonicalPdfBlock;

/**
 * Reference to a persisted tool result whose body lives on disk. Replaces
 * legacy `<persisted-output>` XML (intentional_difference §4.4) — the model
 * sees a stable structured block instead of an XML envelope so providers can
 * render it however they want.
 */
export type CanonicalToolResultReferenceBlock = {
  type: "tool_result_reference";
  toolCallId: string;
  /** Absolute path to the persisted file. */
  path: string;
  /** Original size in bytes / characters of the full result. */
  originalBytes: number;
  /** Truncated preview (UTF-8 text) sent inline alongside the reference. */
  preview: string;
  /** True when `preview` does not contain the entire body. */
  hasMore: boolean;
  /** Optional MIME hint (`application/json`, `text/plain`, ...). */
  mimeType?: string;
  /** Optional friendly description of why the body was persisted. */
  reason?: string;
};

export type CanonicalToolResult = CanonicalToolResultBlock;

export type CanonicalContentBlock =
  | CanonicalTextBlock
  | CanonicalThinkingBlock
  | CanonicalImageBlock
  | CanonicalPdfBlock
  | CanonicalAudioBlock
  | CanonicalToolCallBlock
  | CanonicalToolResultBlock
  | CanonicalToolResultReferenceBlock;

export type CanonicalMessageMetadata = {
  /** True for messages injected by the system (e.g. JSON self-correct prompts). */
  synthetic?: boolean;
  purpose?: string;
};

export type CanonicalMessage = {
  role: CanonicalRole;
  content: CanonicalContentBlock[];
  metadata?: CanonicalMessageMetadata;
};

export type CanonicalToolSchema = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type CanonicalToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      name: string;
    };

export type CanonicalThinkingConfig = {
  enabled: boolean;
  budgetTokens?: number;
};

/**
 * Provider-native structured output (A3). Pinned at the request layer:
 *   - OpenAI: lowered to `response_format: { type: "json_schema", json_schema }`.
 *     `strict: true` is set unless the schema explicitly opts out.
 *   - Anthropic: lowered to a forced hidden tool (`__output__`) plus
 *     `tool_choice: { type: "tool", name: "__output__" }`. The structured
 *     payload is then read back from the assistant's `tool_use` block.
 *
 * Behaviour rationale: legacy `structured_output` is an SDK-side hook tool;
 * PilotDeck adopts provider-native enforcement. Tagged `intentional_difference`
 * in the dual-parity table.
 */
export type CanonicalOutputSchema = {
  /** Stable name passed to the provider (also used as the Anthropic tool name). */
  name: string;
  /** Free-form description forwarded verbatim. */
  description?: string;
  /** JSON schema (object or top-level scalar). */
  schema: Record<string, unknown>;
  /**
   * When true (default), enforces strict adherence:
   *   - OpenAI: `strict: true` on the json_schema entry.
   *   - Anthropic: forces tool_choice; passing `false` leaves the tool
   *     definition without forcing it.
   */
  strict?: boolean;
};

export type CanonicalModelRequest = {
  model: string;
  provider: string;
  messages: CanonicalMessage[];
  systemPrompt?: string;
  tools?: CanonicalToolSchema[];
  toolChoice?: CanonicalToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: CanonicalThinkingConfig;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  /** A3: provider-native structured output (see CanonicalOutputSchema). */
  outputSchema?: CanonicalOutputSchema;
  /**
   * A4: indices into `messages` whose final content block should be marked
   * `cache_control: { type: "ephemeral" }` when lowered to Anthropic. Other
   * providers ignore this. Set by `CachedMicroCompactionEngine`.
   */
  cacheBreakpoints?: number[];
};

export type CanonicalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  /** Cost reported by the API provider (e.g. OpenRouter `usage.cost`). */
  nativeCost?: number;
};

export type CanonicalFinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "error"
  | "unknown";

export type CanonicalModelEvent =
  | { type: "request_started"; provider: string; model: string; metadata?: Record<string, unknown> }
  | { type: "message_start"; role: "assistant"; raw?: unknown }
  | { type: "text_delta"; text: string; raw?: unknown }
  | { type: "thinking_delta"; text: string; signature?: string; raw?: unknown }
  | { type: "tool_call_start"; id: string; name: string; raw?: unknown }
  | { type: "tool_call_delta"; id: string; delta: string; raw?: unknown }
  | { type: "tool_call_end"; toolCall: CanonicalToolCall; raw?: unknown }
  | { type: "message_end"; finishReason: CanonicalFinishReason; raw?: unknown }
  | { type: "usage"; usage: CanonicalUsage; raw?: unknown }
  | { type: "error"; error: CanonicalModelError };

export type CanonicalModelResponse = {
  role: "assistant";
  content: CanonicalContentBlock[];
  usage?: CanonicalUsage;
  finishReason: CanonicalFinishReason;
  raw?: unknown;
};

export type ModelDefinition = {
  id: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  aliases?: string[];
};

export type ProviderConfig = {
  id: string;
  protocol: ModelProtocol;
  url: string;
  apiKey: string;
  timeoutMs?: number;
  headers: Record<string, string>;
  /** Arbitrary fields merged into every request body (e.g. OpenRouter provider preferences). */
  extraBody?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  models: Record<string, ModelDefinition>;
};

export type ModelConfig = {
  providers: Record<string, ProviderConfig>;
};
