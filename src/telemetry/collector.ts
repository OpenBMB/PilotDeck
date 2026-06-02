import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { normalizeProviderBaseUrl } from "../model/normalizeProviderBaseUrl.js";
import { resolvePilotHome } from "../pilot/paths.js";
import { hashTelemetryId, resolveTelemetryRuntimeContext } from "./context.js";
import { TelemetrySender } from "./sender.js";
import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsEventProperties,
  type TelemetryClient,
  type TelemetryConfig,
  type TelemetryErrorCategory,
  type TelemetryErrorInput,
  type TelemetryFeatureUsedInput,
  type TelemetryExecutionKind,
  type TelemetryLoopStage,
  type TelemetryModule,
  type TelemetryOutcome,
  type TelemetryRuntimeContext,
  type TelemetryTrackContext,
} from "./types.js";

type CreateTelemetryCollectorInput = {
  env?: Record<string, string | undefined>;
  pilotHome?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "http://tele.pilotdeck.cn";

const PATH_LIKE_KEY = /path|cwd|root|dir|file/i;
const ABSOLUTE_PATH_VALUE = /^([A-Za-z]:)?[/\\]/;

export function createTelemetryCollector(
  input: CreateTelemetryCollectorInput = {},
): TelemetryClient {
  const env = input.env ?? process.env;
  const config = resolveTelemetryConfig(env, input.pilotHome);
  const runtimeContext = resolveTelemetryRuntimeContext({ env, pilotHome: input.pilotHome });
  const sender = new TelemetrySender(config, { fetchImpl: input.fetchImpl });

  return {
    track(eventName, properties = {}, context = {}) {
      if (!config.enabled) return;
      sender.enqueue(buildEvent({
        eventName,
        properties: sanitizeProperties(properties),
        context,
        runtimeContext,
      }));
    },
    trackFeatureUsed(inputFeature) {
      this.trackFeatureLoopStage(inputFeature);
    },
    trackFeatureLoopStage(inputFeature) {
      const {
        module,
        ownerModule,
        executionKind,
        phase,
        loopStage,
        outcome = "success",
        errorCategory,
        metadata = {},
        ...context
      } = inputFeature;
      this.track("feature_used", {
        module,
        ownerModule: ownerModule ?? module,
        ...(executionKind ? { executionKind } : {}),
        ...(phase ? { phase } : {}),
        loopStage,
        outcome,
        ...(errorCategory ? { errorCategory } : {}),
        ...sanitizeProperties(metadata),
      }, context);
    },
    trackError(error, inputError = {}) {
      const err = normalizeErrorCode(error);
      const module = inputError.module ?? "runtime";
      const ownerModule = inputError.ownerModule ?? module;
      const loopStage = inputError.loopStage ?? "loop_end";
      const errorCategory = inputError.errorCategory ?? "runtime_error";
      const code = inputError.code ?? err;
      this.track("error_occurred", {
        module,
        ownerModule,
        ...(inputError.executionKind ? { executionKind: inputError.executionKind } : {}),
        ...(inputError.phase ? { phase: inputError.phase } : {}),
        loopStage,
        errorCategory,
        code,
        ...(inputError.toolName ? { toolName: inputError.toolName } : {}),
      }, inputError);
      if (!isTelemetryModule(module) || !isTelemetryModule(ownerModule)) {
        return;
      }
      this.trackFeatureLoopStage({
        module,
        ownerModule,
        executionKind: normalizeExecutionKind(inputError.executionKind),
        phase: inputError.phase,
        loopStage: normalizeLoopStage(loopStage),
        outcome: "failed",
        errorCategory: normalizeErrorCategory(errorCategory),
        sessionId: inputError.sessionId,
        metadata: sanitizeProperties(pickErrorFeatureMetadata(code, inputError.toolName, inputError.metadata)),
      });
    },
    flush() {
      return sender.flush();
    },
    shutdown() {
      return sender.shutdown();
    },
    snapshot() {
      return sender.snapshot();
    },
    getConfig() {
      return { ...config };
    },
  };
}

function resolveTelemetryConfig(
  env: Record<string, string | undefined>,
  pilotHomeOverride?: string,
): TelemetryConfig {
  const enabled = parseEnabledFlag(env.ANALYTICS_ENABLED, false);
  const pilotHome = pilotHomeOverride ?? resolvePilotHome(env);
  const queueFilePath = env.ANALYTICS_QUEUE_FILE
    ? resolve(env.ANALYTICS_QUEUE_FILE)
    : join(pilotHome, "telemetry", "queue.jsonl");

  return {
    enabled,
    baseUrl: (env.ANALYTICS_BASE_URL ?? DEFAULT_BASE_URL).trim(),
    flushIntervalMs: parsePositiveInt(env.ANALYTICS_FLUSH_INTERVAL_MS, 5000),
    batchSize: parsePositiveInt(env.ANALYTICS_BATCH_SIZE, 20),
    timeoutMs: parsePositiveInt(env.ANALYTICS_TIMEOUT_MS, 4000),
    maxRetries: parseNonNegativeInt(env.ANALYTICS_MAX_RETRIES, 3),
    maxQueueSize: parsePositiveInt(env.ANALYTICS_MAX_QUEUE_SIZE, 2000),
    queueFilePath,
  };
}

function buildEvent(input: {
  eventName: AnalyticsEventName;
  properties: AnalyticsEventProperties;
  context: TelemetryTrackContext;
  runtimeContext: TelemetryRuntimeContext;
}): AnalyticsEvent {
  const rawSessionId = input.context.sessionId;
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    eventId: randomUUID(),
    eventName: input.eventName,
    occurredAt: new Date().toISOString(),
    installationId: input.runtimeContext.installationId,
    instanceId: input.runtimeContext.instanceId,
    deploymentMode: input.runtimeContext.deploymentMode,
    sessionId: rawSessionId ? hashTelemetryId(rawSessionId) : undefined,
    commitHash: input.runtimeContext.commitHash,
    appVersion: input.runtimeContext.appVersion,
    platform: input.runtimeContext.platform,
    properties: input.properties,
  };
}

function pickErrorFeatureMetadata(
  code: string,
  toolName: string | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { code };
  if (toolName) {
    out.toolName = toolName;
  }
  if (!metadata) {
    return out;
  }
  if (typeof metadata.provider === "string") {
    out.provider = metadata.provider;
  }
  if (typeof metadata.model === "string") {
    out.model = metadata.model;
  }
  if (typeof metadata.providerBaseUrl === "string") {
    const normalized = normalizeProviderBaseUrl(metadata.providerBaseUrl);
    if (normalized) {
      out.providerBaseUrl = normalized;
    }
  }
  return out;
}

export function sanitizeProperties(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_LIKE_KEY.test(key)) {
      continue;
    }
    const sanitized = sanitizePropertyValue(entry);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function sanitizePropertyValue(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return looksLikeAbsolutePath(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizePropertyValue(item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = sanitizeProperties(record);
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  return value;
}

function looksLikeAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_VALUE.test(value.trim());
}

function normalizeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return "UnknownError";
}

function parseEnabledFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeModule(value: string): TelemetryModule {
  if (
    value === "router" ||
    value === "always_on" ||
    value === "memory" ||
    value === "cron_job" ||
    value === "session"
  ) {
    return value;
  }
  return "session";
}

function isTelemetryModule(value: string): value is TelemetryModule {
  return normalizeModule(value) === value;
}

function normalizeLoopStage(value: string): TelemetryLoopStage {
  if (
    value === "module_event" ||
    value === "loop_start" ||
    value === "model_request" ||
    value === "model_response" ||
    value === "tool_prepare" ||
    value === "tool_call" ||
    value === "permission_check" ||
    value === "loop_end"
  ) {
    return value;
  }
  return "loop_end";
}

function normalizeErrorCategory(value: string): TelemetryErrorCategory {
  if (
    value === "model_request_error" ||
    value === "permission_error" ||
    value === "tool_param_error" ||
    value === "tool_runtime_error" ||
    value === "tool_result_parse_error" ||
    value === "loop_error" ||
    value === "runtime_error"
  ) {
    return value;
  }
  return "runtime_error";
}

function normalizeExecutionKind(value: TelemetryExecutionKind | undefined): TelemetryExecutionKind | undefined {
  if (
    value === "user_session" ||
    value === "subagent" ||
    value === "always_on" ||
    value === "router_judge" ||
    value === "memory" ||
    value === "cron_job" ||
    value === "compaction" ||
    value === "tool_secondary"
  ) {
    return value;
  }
  return undefined;
}
