import {
  snapshotCanonicalModelRequest,
  ModelProviderError,
  type CanonicalModelEvent,
  type CanonicalModelError,
  type CanonicalModelRequest,
} from "../../../model/index.js";
import type {
  HostModelModuleMethod,
  ModelExecutionContext,
  ModelInvokerPort,
  ModuleCallRequest,
  ModuleResponse,
  PreparedModelInvocation,
} from "../protocol.js";

type ModelModuleCall = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  idempotencyKey?: string;
  recordFailure?: boolean;
  abortSignal?: AbortSignal;
};

export type HostModelModuleClient = (request: ModelModuleCall) => Promise<ModuleResponse>;

export type HostModelInvokerPortOptions = {
  uuid?: () => string;
  /** A host must explicitly advertise prepare before the consumer calls it remotely. */
  methods?: readonly HostModelModuleMethod[];
  /** Receives an optional host-owned metadata snapshot returned with prepare. */
  onPreparedMetadata?: (metadata: unknown, prepared: PreparedModelInvocation) => void;
};

export type HostModelInvokerPort = ModelInvokerPort & Readonly<{
  /**
   * Materialize an already prepared invocation through the host routing
   * capability. The preparation id is transport-local and never reveals the
   * host's opaque routing state to the sidecar.
   */
  materializePreparedRequest?: (
    prepared: PreparedModelInvocation,
    request: CanonicalModelRequest,
  ) => Promise<CanonicalModelRequest>;
}>;

const preparationIdSymbol = Symbol("pilotdeck.hostModelPreparationId");

type PreparedInvocationWithIdentity = PreparedModelInvocation & {
  [preparationIdSymbol]?: string;
};

// Materialized canonical requests are immutable snapshots. Keep the host-only
// preparation association out-of-band so this adapter never mutates a request
// supplied by the caller or serialized across the module boundary.
const requestPreparationIds = new WeakMap<CanonicalModelRequest, string>();

export function readHostModelRequestPreparationId(request: CanonicalModelRequest): string | undefined {
  return requestPreparationIds.get(request);
}

function rememberRequestPreparationId(request: CanonicalModelRequest, preparationId: string): CanonicalModelRequest {
  requestPreparationIds.set(request, preparationId);
  return request;
}

/** ModelInvokerPort consumer backed by a host-owned model module. */
export function createHostModelInvokerPort(
  callModule: HostModelModuleClient,
  options: HostModelInvokerPortOptions = {},
): HostModelInvokerPort {
  const uuid = options.uuid ?? (() => Math.random().toString(36).slice(2));
  const preparationIds = new WeakMap<PreparedModelInvocation, string>();
  let preparationSequence = 0;
  const nextPreparationId = (): string => `prepared-${uuid()}-${++preparationSequence}`;
  const supportsRemotePrepare = options.methods?.includes("prepare") === true;
  const supportsPullStream = options.methods?.includes("stream_next") === true;
  const supportsCloseStream = options.methods?.includes("close_stream") === true;
  const supportsMaterialize = options.methods?.includes("materialize_prepared_request") === true;
  const preparationContexts = new WeakMap<PreparedModelInvocation, ModelExecutionContext>();
  const remember = (prepared: PreparedModelInvocation, preparationId: string, context?: ModelExecutionContext): void => {
    rememberPreparationId(prepared, preparationId, preparationIds);
    if (context) preparationContexts.set(prepared, context);
  };
  return {
    async prepare({ request, context }): Promise<PreparedModelInvocation> {
      const fallback: PreparedModelInvocation = {
        request: snapshotCanonicalModelRequest(request),
        provider: request.provider,
        model: request.model,
      };
      const preparationId = nextPreparationId();
      if (!supportsRemotePrepare) {
        remember(fallback, preparationId, context);
        return fallback;
      }
      const response = await callModule({
        runId: context.runId,
        operationId: context.operationId ?? context.turnId,
        idempotencyKey: context.idempotencyKey,
        requestId: `model-prepare-${uuid()}`,
        module: "model",
        abortSignal: context.abortSignal,
        payload: {
          operation: "prepare",
          request: fallback.request,
          preparationId,
          context: serializeModelExecutionContext(context),
        },
      });
      const prepared = readPreparedInvocation(response, fallback);
      options.onPreparedMetadata?.(response.payload?.metadata, prepared);
      remember(prepared, preparationId, context);
      return prepared;
    },
    ...(supportsMaterialize ? {
      async materializePreparedRequest(
        prepared: PreparedModelInvocation,
        request: CanonicalModelRequest,
      ): Promise<CanonicalModelRequest> {
        const preparationId = readPreparationId(prepared, preparationIds);
        const context = preparationContexts.get(prepared);
        if (!preparationId || !context) {
          throw invalidModelResponse("Prepared invocation is not bound to a host model request.");
        }
        const response = await callModule({
          runId: context.runId,
          operationId: context.operationId ?? context.turnId,
          idempotencyKey: context.idempotencyKey,
          requestId: `model-materialize-${uuid()}`,
          module: "model",
          payload: {
            operation: "materialize_prepared_request",
            preparationId,
            request: snapshotCanonicalModelRequest(request),
          },
        });
        assertModelResponse(response, "Model request materialization failed");
        const materialized = response.payload?.request;
        if (!materialized || typeof materialized !== "object") {
          throw invalidModelResponse("Model materialization response must contain a canonical request.");
        }
        return rememberRequestPreparationId(
          snapshotCanonicalModelRequest(materialized as CanonicalModelRequest),
          preparationId,
        );
      },
    } : {}),
    async *stream({ prepared, context }): AsyncIterable<CanonicalModelEvent> {
      let preparationId = readPreparationId(prepared, preparationIds);
      if (!preparationId) {
        preparationId = nextPreparationId();
        remember(prepared, preparationId, context);
      }
      if (supportsPullStream) {
        let done = false;
        try {
          while (!done) {
            const response = await callModule({
              runId: context.runId,
              operationId: context.operationId ?? context.turnId,
              idempotencyKey: context.idempotencyKey,
              requestId: `model-stream-next-${uuid()}`,
              module: "model",
              abortSignal: context.abortSignal,
              payload: {
                operation: "stream_next",
                request: snapshotCanonicalModelRequest(prepared.request),
                preparationId,
                context: serializeModelExecutionContext(context),
              },
            });
            assertModelResponse(response, "Model stream failed");
            const events = response.payload?.events;
            if (!Array.isArray(events) || typeof response.payload?.done !== "boolean") {
              throw invalidModelResponse("Model stream_next response must contain events and done.");
            }
            for (const event of events) yield event as CanonicalModelEvent;
            done = response.payload.done;
          }
        } finally {
          if (!done && supportsCloseStream) {
            await callModule({
              runId: context.runId,
              operationId: context.operationId ?? context.turnId,
              idempotencyKey: context.idempotencyKey,
              requestId: `model-close-stream-${uuid()}`,
              module: "model",
              recordFailure: false,
              payload: { operation: "close_stream", preparationId },
            }).catch(() => undefined);
          }
        }
        return;
      }
      const response = await callModule({
        runId: context.runId,
        operationId: context.operationId ?? context.turnId,
        idempotencyKey: context.idempotencyKey,
        requestId: `model-${uuid()}`,
        module: "model",
        abortSignal: context.abortSignal,
        payload: {
          operation: "stream",
          request: prepared.request,
          preparationId,
          context: serializeModelExecutionContext(context),
        },
      });
      assertModelResponse(response, "Model module failed");
      const events = response.payload?.events;
      if (!Array.isArray(events)) {
        throw invalidModelResponse("Model module response must contain canonical events.");
      }
      for (const event of events) yield event as CanonicalModelEvent;
    },
  };
}

function assertModelResponse(response: ModuleResponse, fallback: string): void {
  if (response.ok) return;
  throw moduleFailure(response, fallback);
}

function invalidModelResponse(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_MODEL_RESPONSE" });
}

function rememberPreparationId(
  prepared: PreparedModelInvocation,
  preparationId: string,
  preparationIds: WeakMap<PreparedModelInvocation, string>,
): void {
  preparationIds.set(prepared, preparationId);
  // AgentLoop may replace a prepared invocation with an object spread after
  // applying token caps. Enumerable symbols survive that local copy but are
  // not serialized into a host module payload.
  Object.defineProperty(prepared, preparationIdSymbol, {
    value: preparationId,
    enumerable: true,
  });
}

function readPreparationId(
  prepared: PreparedModelInvocation,
  preparationIds: WeakMap<PreparedModelInvocation, string>,
): string | undefined {
  return (prepared as PreparedInvocationWithIdentity)[preparationIdSymbol]
    ?? preparationIds.get(prepared);
}

function readPreparedInvocation(
  response: ModuleResponse,
  fallback: PreparedModelInvocation,
): PreparedModelInvocation {
  if (!response.ok) throw moduleFailure(response, "Model prepare failed");
  const projection = response.payload?.prepared;
  if (!projection || typeof projection !== "object") {
    const failure = new Error("Model prepare response must contain a prepared invocation.") as Error & { code?: string };
    failure.code = "INVALID_MODEL_PREPARATION";
    throw failure;
  }
  const value = projection as Record<string, unknown>;
  if (typeof value.provider !== "string" || typeof value.model !== "string" || !value.request || typeof value.request !== "object") {
    const failure = new Error("Model prepare response contains an invalid prepared invocation.") as Error & { code?: string };
    failure.code = "INVALID_MODEL_PREPARATION";
    throw failure;
  }
  return {
    request: snapshotCanonicalModelRequest(value.request as CanonicalModelRequest),
    provider: value.provider,
    model: value.model,
    ...(positiveInteger(value.maxContextTokens) ? { maxContextTokens: positiveInteger(value.maxContextTokens) } : {}),
    ...(positiveInteger(value.maxOutputTokens) ? { maxOutputTokens: positiveInteger(value.maxOutputTokens) } : {}),
  };
}

function moduleFailure(response: ModuleResponse, fallback: string): Error & { code?: string; retryable?: boolean; retryAfterMs?: number } {
  const canonical = response.error?.canonical;
  if (isCanonicalModelError(canonical)) {
    return new ModelProviderError(canonical) as Error & { code?: string; retryable?: boolean; retryAfterMs?: number };
  }
  const failure = new Error(
    String(response.error?.message ?? response.code ?? fallback),
  ) as Error & { code?: string; retryable?: boolean; retryAfterMs?: number };
  failure.code = response.code;
  if (typeof response.error?.retryable === "boolean") failure.retryable = response.error.retryable;
  if (typeof response.error?.retryAfterMs === "number") failure.retryAfterMs = response.error.retryAfterMs;
  return failure;
}

function isCanonicalModelError(value: unknown): value is CanonicalModelError {
  return !!value
    && typeof value === "object"
    && typeof (value as { code?: unknown }).code === "string"
    && typeof (value as { message?: unknown }).message === "string";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function serializeModelExecutionContext(context: ModelExecutionContext): Record<string, unknown> {
  const { abortSignal: _abortSignal, ...serializable } = context;
  return serializable;
}
