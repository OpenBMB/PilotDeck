import type { AgentError, AgentEvent, AgentTurnResult } from "../../agent/index.js";
import {
  flattenToolResultBlockText,
  type CanonicalModelError,
  type CanonicalModelEvent,
} from "../../model/index.js";
import { contentToText } from "../../tool/index.js";
import type { GatewayEvent } from "../protocol/types.js";
import { GatewayToolResultArtifactStore } from "./GatewayToolResultArtifactStore.js";
import type { GatewayToolResultArtifactStorePort } from "./GatewayToolResultArtifactStorePort.js";
import type {
  GatewayAgentEventProjectionInput,
  GatewayAgentEventProjectorPort,
} from "./GatewayAgentEventProjectorPort.js";

const MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS = 20_000;
const MAX_GATEWAY_TOOL_DATA_STRING_CHARS = 4_000;

export type GatewayAgentEventProjectorOptions = {
  toolResultArtifacts?: GatewayToolResultArtifactStorePort;
};

/**
 * Native Gateway live-event projection provider.
 *
 * Agent events are already canonical and Session-owned when they reach this
 * provider. This class only derives Gateway frames and delegates advisory
 * large-result preview persistence to the selected artifact store.
 */
export class GatewayAgentEventProjector implements GatewayAgentEventProjectorPort {
  private readonly toolResultArtifacts: GatewayToolResultArtifactStorePort;

  constructor(options: GatewayAgentEventProjectorOptions = {}) {
    this.toolResultArtifacts = options.toolResultArtifacts ?? new GatewayToolResultArtifactStore();
  }

  project(input: GatewayAgentEventProjectionInput): GatewayEvent[] {
    return projectAgentEventForTurn(input.event, input.runId, this.toolResultArtifacts, input.forwardSubagentText === true).map((event) =>
      withGatewayRunId({
        ...event,
        ...(input.event.timeline && event.type !== "assistant_attachment"
          ? { timeline: input.event.timeline }
          : {}),
        ...(input.event.streamBoundary ? { streamBoundary: input.event.streamBoundary } : {}),
      }, input.runId)
    );
  }
}

const DEFAULT_PROJECTOR = new GatewayAgentEventProjector();

/**
 * Compatibility facade for direct callers and existing mapper tests.
 * Application composition should inject `GatewayAgentEventProjectorPort` into
 * `InProcessGateway` instead of selecting an artifact provider per call.
 */
export function mapAgentEvent(
  event: AgentEvent,
  runId: string,
  options: GatewayToolResultArtifactStorePort | { forwardSubagentText?: boolean } = {},
): GatewayEvent[] {
  const toolResultArtifacts = "persist" in options ? options : undefined;
  const projector = toolResultArtifacts ? new GatewayAgentEventProjector({ toolResultArtifacts }) : DEFAULT_PROJECTOR;
  return projector.project({
    event,
    runId,
    ...("forwardSubagentText" in options ? { forwardSubagentText: options.forwardSubagentText } : {}),
  });
}

function projectAgentEventForTurn(
  event: AgentEvent,
  runId: string,
  toolResultArtifacts: GatewayToolResultArtifactStorePort,
  forwardSubagentText: boolean,
): GatewayEvent[] {
  switch (event.type) {
    case "turn_started":
      return [{ type: "turn_started", runId }];
    case "input_accepted":
      return [{ type: "input_accepted", runId }];
    case "steer_applied":
      return [{
        type: "steer_applied",
        itemId: event.itemId,
        message: event.message,
        ...(event.message.content.find((block) => block.timeline)?.timeline
          ? { timeline: event.message.content.find((block) => block.timeline)!.timeline }
          : {}),
      }];
    case "steer_unapplied":
      return [{ type: "steer_unapplied", itemId: event.itemId, reason: event.reason }];
    case "model_request_started":
      return [{ type: "model_request_started", model: event.model, provider: event.provider }];
    case "model_event":
      return mapModelEvent(event.event, runId).map((frame) =>
        event.blockId ? { ...frame, blockId: event.blockId } : frame
      );
    case "assistant_message":
      return event.message.content.flatMap((block): GatewayEvent[] =>
        (block.type === "text" || block.type === "thinking") && block.blockId && block.timeline
          ? [{
              type: "assistant_block",
              kind: block.type,
              blockId: block.blockId,
              text: block.text,
              timeline: block.timeline,
              streamState: "closed",
              model: event.message.metadata?.model,
            }]
          : block.type === "text"
            ? [{
                type: "assistant_text_delta",
                text: block.text,
                ...(event.message.metadata?.model ? { model: event.message.metadata.model } : {}),
              }]
            : block.type === "thinking"
              ? [{ type: "assistant_thinking_delta", text: block.text }]
          : []
      );
    case "prompt_suggestion":
      return [{ type: "prompt_suggestion", suggestion: event.suggestion }];
    case "tool_calls_detected":
      return event.calls.map((call) => ({
        ...(call.timeline ? { timeline: call.timeline } : {}),
        type: "tool_call_started",
        toolCallId: call.id,
        name: call.name,
        argsPreview: previewUnknown(call.input),
      }));
    case "tool_progress":
      return [{
        type: "tool_progress",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        message: event.message,
        ...(event.metadata ? { metadata: event.metadata } : {}),
        createdAt: event.createdAt,
      }];
    case "tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      const lineCount = lines.length;
      const totalBytes = Buffer.byteLength(fullText, "utf-8");
      const resultPath = toolResultArtifacts.persist({
        sessionId: event.sessionId,
        turnId: event.turnId,
        toolCallId: event.result.toolCallId,
        text: fullText,
      });

      const images = event.result.content.flatMap((item) => item.type === "image"
        ? [{
            mimeType: item.mimeType,
            data: item.data,
            ...(item.bytes !== undefined ? { bytes: item.bytes } : {}),
            ...(item.detail ? { detail: item.detail } : {}),
          }]
        : []);
      const attachments = event.result.content.flatMap((item): GatewayEvent[] => {
        if (item.type === "image" && event.result.toolName !== "read_file") {
          return [{
            type: "assistant_attachment",
            attachment: {
              type: "image",
              mimeType: item.mimeType,
              content: item.data,
              bytes: item.bytes,
              name: `${safeGatewayPathPart(event.result.toolName)}-${safeGatewayPathPart(event.result.toolCallId)}.${extensionForMime(item.mimeType)}`,
              source: "tool_result",
              metadata: { toolCallId: event.result.toolCallId, toolName: event.result.toolName },
            },
          }];
        }
        if (item.type === "file") {
          return [{
            type: "assistant_attachment",
            attachment: {
              type: "file",
              path: item.path,
              mimeType: item.mimeType,
              name: item.path.split(/[\\/]/).pop(),
              source: "tool_result",
              metadata: { toolCallId: event.result.toolCallId, toolName: event.result.toolName, description: item.description },
            },
          }];
        }
        return [];
      });

      return [
        {
          type: "tool_call_finished",
          toolCallId: event.result.toolCallId,
          ok: event.result.type === "success",
          resultPreview,
          resultLineCount: lineCount,
          resultBytes: totalBytes,
          toolName: event.result.toolName,
          resultPath,
          ...(images.length > 0 ? { images } : {}),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
          ...(event.result.type === "success" && event.result.data
            ? { data: sanitizeGatewayToolData(event.result.data) }
            : {}),
        },
        ...attachments,
      ];
    }
    case "file_artifacts":
      return [{ type: "file_artifacts", artifacts: event.artifacts }];
    case "mode_change_requested":
      return [{ type: "plan_mode_changed", mode: event.mode }];
    case "turn_completed":
      return mapTurnCompleted(event.result);
    case "turn_failed":
      return [{
        type: "error",
        code: event.error.code,
        message: event.error.message,
        recoverable: false,
        userHint: event.error.userHint,
        providerError: providerErrorFromAgentError(event.error),
      }];
    case "token_cap_adjusted":
      return [{
        type: "agent_status",
        event: "token_cap_adjusted",
        detail: {
          provider: event.provider,
          model: event.model,
          cap: event.cap,
          previous: event.previous,
          next: event.next,
          reason: event.reason,
        },
      }];
    case "empty_output_recovery":
      return [{
        type: "agent_status",
        event: "empty_output_recovery",
        detail: {
          provider: event.provider,
          model: event.model,
          finishReason: event.finishReason,
          previousMaxOutputTokens: event.previousMaxOutputTokens,
          nextMaxOutputTokens: event.nextMaxOutputTokens,
        },
      }];
    case "model_recovery_failed":
      return [{
        type: "agent_status",
        event: "model_recovery_failed",
        detail: {
          provider: event.provider,
          model: event.model,
          code: event.error.code,
          message: event.error.message,
          providerError: providerErrorFromModelError(event.error),
        },
      }];
    case "session_aborted":
      return [{
        type: "error",
        code: "agent_aborted",
        message: event.reason ?? "Session aborted.",
        recoverable: true,
      }];
    case "tool_results_projected": {
      const events: GatewayEvent[] = [];
      for (const block of event.message.content) {
        if (block.type === "tool_result_reference") {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
        } else if (block.type === "media_reference" && block.toolCallId) {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            resultPath: block.path,
          });
          if (block.reason === "media_result_too_large") continue;
          events.push({
            type: "assistant_attachment",
            attachment: {
              type: block.mediaType === "image" ? "image" : "file",
              path: block.path,
              mimeType: block.mimeType,
              bytes: block.originalBytes,
              name: block.path.split(/[\\/]/).pop(),
              source: "media_reference",
              metadata: { toolCallId: block.toolCallId, reason: block.reason },
            },
          });
        } else if (block.type === "tool_result") {
          events.push({
            type: "tool_result_detail_available",
            toolCallId: block.toolCallId,
            fullText: flattenToolResultBlockText(block),
          });
        }
      }
      return events;
    }
    case "compact_started":
      return [{
        type: "agent_status",
        event: "compact_started",
        detail: {
          compactionId: event.compactionId,
          trigger: event.trigger,
          preTokens: event.preTokens,
        },
      }];
    case "compact_completed":
      return [{
        type: "agent_status",
        event: "compact_completed",
        detail: {
          compactionId: event.compactionId,
          trigger: event.trigger,
          status: event.status,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          messagesSummarized: event.messagesSummarized,
        },
      }];
    case "context_budget": {
      const reservedOutputTokens = event.snapshot.reservedOutputTokens ?? event.snapshot.maxOutputTokens ?? 0;
      const totalContextTokens = event.snapshot.effectiveContextTokens !== undefined
        ? event.snapshot.totalContextTokens ?? event.snapshot.effectiveContextTokens + reservedOutputTokens
        : event.snapshot.totalContextTokens ?? event.snapshot.maxContextTokens + reservedOutputTokens;
      return [{
        type: "context_budget",
        used: event.snapshot.tokens,
        displayUsed: event.snapshot.tokens,
        ...(event.snapshot.localEstimateTokens !== undefined ? { localEstimateTokens: event.snapshot.localEstimateTokens } : {}),
        ...(event.snapshot.displayTokens !== undefined ? { displayTokens: event.snapshot.displayTokens } : {}),
        ...(event.snapshot.estimateSource !== undefined ? { estimateSource: event.snapshot.estimateSource } : {}),
        ...(event.snapshot.usageTokens !== undefined ? { usageTokens: event.snapshot.usageTokens } : {}),
        ...(event.snapshot.calibrationActualInputTokens !== undefined
          ? { calibrationActualInputTokens: event.snapshot.calibrationActualInputTokens }
          : {}),
        ...(event.snapshot.calibrationEstimatedInputTokens !== undefined
          ? { calibrationEstimatedInputTokens: event.snapshot.calibrationEstimatedInputTokens }
          : {}),
        total: totalContextTokens,
        ...(event.snapshot.totalContextTokens !== undefined ? { totalContextTokens: event.snapshot.totalContextTokens } : {}),
        maxContextTokens: event.snapshot.maxContextTokens,
        effectiveTotal: event.snapshot.effectiveContextTokens ?? event.snapshot.maxContextTokens,
        ...(event.snapshot.effectiveContextTokens !== undefined
          ? { effectiveContextTokens: event.snapshot.effectiveContextTokens }
          : {}),
        ...(event.snapshot.maxOutputTokens !== undefined ? { maxOutputTokens: event.snapshot.maxOutputTokens } : {}),
        reservedOutputTokens,
        warningRatio: event.snapshot.warningRatio,
        blockingRatio: event.snapshot.blockingRatio,
        ratio: event.snapshot.ratio,
        state: event.snapshot.state,
        ...(event.snapshot.source !== undefined ? { source: event.snapshot.source } : {}),
        ...(event.snapshot.exact !== undefined ? { exact: event.snapshot.exact } : {}),
        ...(event.snapshot.estimatorError !== undefined ? { estimatorError: event.snapshot.estimatorError } : {}),
        ...(event.snapshot.breakdown !== undefined ? { breakdown: event.snapshot.breakdown } : {}),
      }];
    }
    case "warning":
      return [{
        type: "agent_status",
        event: "warning",
        detail: { code: event.code, message: event.message, metadata: event.metadata },
      }];
    case "agent_status":
      return [{ type: "agent_status", event: event.event, detail: event.detail }];
    case "turn_continued":
      return [{ type: "agent_status", event: "turn_continued", detail: { reason: event.reason } }];
    case "subagent_started":
      return [{
        type: "agent_status",
        event: "subagent_started",
        detail: { subagentId: event.subagentId, subagentType: event.subagentType, toolCallId: event.toolCallId },
      }];
    case "subagent_completed":
      return [{
        type: "agent_status",
        event: "subagent_completed",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          success: event.success,
          ...(event.aborted ? { aborted: true } : {}),
          durationMs: event.durationMs,
        },
      }];
    case "subagent_model_event":
      return mapSubagentModelEvent(event, forwardSubagentText);
    case "subagent_tool_calls_detected":
      return event.calls.map((call) => ({
        type: "agent_status",
        event: "subagent_tool_call_started",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        },
      }));
    case "subagent_tool_result": {
      const fullText = event.result.content.map(contentToText).join("\n");
      const resultPreview = limitGatewayToolResultPreview(fullText);
      const lines = fullText.split("\n");
      return [{
        type: "agent_status",
        event: "subagent_tool_result",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          toolCallId: event.result.toolCallId,
          toolName: event.result.toolName,
          ok: event.result.type === "success",
          content: resultPreview,
          preview: limitGatewayToolResultPreview(lines.slice(0, 3).join("\n")),
          resultLineCount: lines.length,
          resultBytes: Buffer.byteLength(fullText, "utf-8"),
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
        },
      }];
    }
    case "subagent_status":
      return [{
        type: "agent_status",
        event: "subagent_status",
        detail: {
          subagentId: event.subagentId,
          subagentType: event.subagentType,
          status: event.status,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          success: event.success,
          durationMs: event.durationMs,
        },
      }];
    case "retry_progress":
      return [{
        type: "agent_status",
        event: "retry_progress",
        detail: {
          attempt: event.detail.attempt,
          maxAttempts: event.detail.maxAttempts,
          delayMs: event.detail.delayMs,
          reason: event.detail.reason,
          provider: event.detail.provider,
          model: event.detail.model,
        },
      }];
    case "session_ended":
    case "user_prompt_submitted":
    case "setup_completed":
    case "instructions_loaded":
    case "stop_requested":
    case "stop_failure":
    case "elicitation_resolved":
    case "pre_tool_execute":
    case "post_tool_execute":
    case "permission_requested":
    case "elicitation_requested":
      return [];
    case "permission_denied":
      return [{
        type: "permission_denied",
        toolName: event.toolName,
        reason: event.reason,
      }];
    default:
      return [];
  }
}

function limitGatewayToolResultPreview(text: string): string {
  if (text.length <= MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS) return text;
  const marker = `\n\n... [Gateway preview truncated: ${text.length - MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS} characters omitted; full result remains available through persisted tool-result references when shown to the model.] ...\n\n`;
  const available = Math.max(0, MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS - marker.length);
  return `${text.slice(0, Math.ceil(available / 2))}${marker}${text.slice(-Math.floor(available / 2))}`;
}

function sanitizeGatewayToolData(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeGatewayToolDataValue(value);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeGatewayToolDataValue(value: unknown): unknown {
  if (typeof value === "string") return limitGatewayToolDataString(value);
  if (Array.isArray(value)) return value.map(sanitizeGatewayToolDataValue);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = sanitizeGatewayToolDataValue(item);
    return output;
  }
  return value;
}

function limitGatewayToolDataString(value: string): string | { preview: string; originalChars: number; originalBytes: number; truncated: true } {
  if (value.length <= MAX_GATEWAY_TOOL_DATA_STRING_CHARS) return value;
  return {
    preview: headTailString(value, MAX_GATEWAY_TOOL_DATA_STRING_CHARS, "Gateway data string truncated"),
    originalChars: value.length,
    originalBytes: Buffer.byteLength(value, "utf8"),
    truncated: true,
  };
}

function headTailString(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n... [${label}: ${text.length - maxChars} characters omitted] ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, Math.ceil(available / 2))}${marker}${text.slice(-Math.floor(available / 2))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapModelEvent(event: CanonicalModelEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_text_delta", text: event.text, runId }];
    case "thinking_delta":
      return [{ type: "assistant_thinking_delta", text: event.text, runId }];
    case "error":
      return [];
    default:
      return [];
  }
}

function mapSubagentModelEvent(
  event: Extract<AgentEvent, { type: "subagent_model_event" }>,
  forwardSubagentText: boolean,
): GatewayEvent[] {
  const base = { subagentId: event.subagentId, subagentType: event.subagentType };
  switch (event.event.type) {
    case "text_delta":
      if (forwardSubagentText) {
        return [{ type: "subagent_text_delta", ...base, text: event.event.text }];
      }
      return [{ type: "agent_status", event: "subagent_text_delta", detail: { ...base, text: event.event.text } }];
    case "thinking_delta":
      return [{ type: "agent_status", event: "subagent_thinking_delta", detail: { ...base, text: event.event.text } }];
    case "error":
      return [{
        type: "agent_status",
        event: "subagent_model_error",
        detail: { ...base, code: event.event.error.code, message: event.event.error.message },
      }];
    default:
      return [];
  }
}

function mapTurnCompleted(result: AgentTurnResult): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  if (result.structuredOutput !== undefined) events.push({ type: "structured_output", payload: result.structuredOutput });
  events.push({ type: "turn_completed", usage: result.usage, finishReason: result.stopReason });
  return events;
}

function previewUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeGatewayPathPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "value";
}

type GatewayEventProviderError = NonNullable<Extract<GatewayEvent, { type: "error" }> ["providerError"]>;

function providerErrorFromAgentError(error: AgentError): GatewayEventProviderError | undefined {
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  return providerErrorFromRecord(details as Record<string, unknown>);
}

function providerErrorFromModelError(error: CanonicalModelError): GatewayEventProviderError {
  return {
    provider: error.provider,
    protocol: error.protocol,
    status: error.status,
    code: error.code,
    message: error.message,
    raw: stringifyProviderRaw(error.raw),
  };
}

function providerErrorFromRecord(details: Record<string, unknown>): GatewayEventProviderError | undefined {
  const provider = stringOrUndefined(details.provider);
  const protocol = stringOrUndefined(details.protocol);
  const status = numberOrUndefined(details.status);
  const code = stringOrUndefined(details.code);
  const message = stringOrUndefined(details.message);
  const raw = stringifyProviderRaw(details.raw);
  if (!provider && !protocol && status === undefined && !code && !message && !raw) return undefined;
  return { provider, protocol, status, code, message, raw };
}

function stringifyProviderRaw(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw : safeJsonStringify(raw);
  if (!text) return undefined;
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

function getGatewayEventRunId(event: GatewayEvent): string | undefined {
  return typeof event.runId === "string" && event.runId.trim() ? event.runId.trim() : undefined;
}

function withGatewayRunId(event: GatewayEvent, runId: string): GatewayEvent {
  return getGatewayEventRunId(event) ? event : { ...event, runId };
}
