import type {
  StaffDeckSopBundle,
  StaffDeckSopModuleManifest,
  StaffDeckSopOperation,
  StaffDeckSopOperationContext,
  StaffDeckSopPrepareResponse,
  StaffDeckSopRequestEnvelope,
  StaffDeckSopResponseEnvelope,
  StaffDeckSopRuntimeClient,
  StaffDeckSopState,
  StaffDeckSopSubmitResponse,
  SopRuntimeManifestExpectation,
} from "./types.js";
import {
  STAFFDECK_SOP_CONTRACT,
  STAFFDECK_SOP_MODULE_ID,
  STAFFDECK_SOP_OPERATIONS,
  STAFFDECK_SOP_PROTOCOL_VERSION,
} from "./types.js";

type FetchLike = typeof fetch;

export class StaffDeckSopClientError extends Error {
  readonly name = "StaffDeckSopClientError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryability?: "safe" | "unsafe" | "retry_after_status",
  ) {
    super(message);
  }
}

/** HTTP client for the stateless StaffDeck portable SOP runtime. */
export class StaffDeckSopClient implements StaffDeckSopRuntimeClient {
  private readonly endpoint: string;
  private manifestPromise: Promise<StaffDeckSopModuleManifest> | undefined;

  constructor(
    endpoint: string,
    private readonly options: {
      fetch?: FetchLike;
      timeoutMs?: number;
      manifestPath?: string;
      expectedManifest?: SopRuntimeManifestExpectation;
    } = {},
  ) {
    this.endpoint = endpoint.replace(/\/+$/u, "");
  }

  async prepare(input: {
    bundle: StaffDeckSopBundle;
    state: StaffDeckSopState;
    context?: StaffDeckSopOperationContext;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopPrepareResponse> {
    const payload = await this.post("prepare", {
      bundle: input.bundle,
      state: input.state,
    }, input.context, input.signal);
    return validatePreparePayload(payload);
  }

  async submit(input: {
    bundle: StaffDeckSopBundle;
    state: StaffDeckSopState;
    proposal: import("./types.js").StaffDeckSopProposal;
    successfulToolNames: readonly string[];
    context?: StaffDeckSopOperationContext;
    signal?: AbortSignal;
  }): Promise<StaffDeckSopSubmitResponse> {
    const payload = await this.post("submit", {
      bundle: input.bundle,
      state: input.state,
      proposal: input.proposal,
      successfulToolNames: [...input.successfulToolNames],
    }, input.context, input.signal);
    return validateSubmitPayload(payload);
  }

  private async post(
    operation: StaffDeckSopOperation,
    payload: Record<string, unknown>,
    context: StaffDeckSopOperationContext | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.manifest(signal);
    const request = requestEnvelope(operation, payload, context);
    const response = await this.request(`/v1/sop/${operation}`, request, signal);
    const envelope = validateResponseEnvelope(response.payload, request.requestId);
    if (!envelope.ok) {
      const error = envelope.error!;
      throw new StaffDeckSopClientError(error.code, error.message, error.details, error.retryability);
    }
    if (!response.response.ok) {
      throw new StaffDeckSopClientError(
        "SOP_RUNTIME_PROTOCOL",
        `StaffDeck SOP runtime returned HTTP ${response.response.status} with a successful envelope.`,
      );
    }
    if (!envelope.payload) {
      throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime success envelope has no payload.");
    }
    return envelope.payload;
  }

  private manifest(signal?: AbortSignal): Promise<StaffDeckSopModuleManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchManifest(signal).catch((error: unknown) => {
        this.manifestPromise = undefined;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  private async fetchManifest(signal?: AbortSignal): Promise<StaffDeckSopModuleManifest> {
    const result = await this.request(this.options.manifestPath ?? "/healthz", undefined, signal, "GET");
    if (!result.response.ok) {
      throw new StaffDeckSopClientError(
        "SOP_RUNTIME_UNAVAILABLE",
        `StaffDeck SOP runtime health check returned HTTP ${result.response.status}.`,
      );
    }
    return validateManifest(result.payload, this.options.expectedManifest);
  }

  private async request(
    path: string,
    body: StaffDeckSopRequestEnvelope | undefined,
    signal?: AbortSignal,
    method: "GET" | "POST" = "POST",
  ): Promise<{ response: Response; payload: unknown }> {
    const fetcher = this.options.fetch ?? fetch;
    const timeoutController = this.options.timeoutMs === undefined ? undefined : new AbortController();
    const timeoutId = timeoutController && setTimeout(
      () => timeoutController.abort(new DOMException("StaffDeck SOP runtime request timed out.", "TimeoutError")),
      this.options.timeoutMs,
    );
    const combined = timeoutController && signal
      ? AbortSignal.any([timeoutController.signal, signal])
      : timeoutController?.signal ?? signal;
    let response: Response;
    try {
      response = await fetcher(`${this.endpoint}${path}`, {
        method,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: combined,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (signal?.aborted && !timeoutController?.signal.aborted) {
        throw new StaffDeckSopClientError("SOP_RUNTIME_CANCELLED", `StaffDeck SOP runtime request was cancelled: ${reason}`, undefined, "unsafe");
      }
      throw new StaffDeckSopClientError("SOP_RUNTIME_UNAVAILABLE", `StaffDeck SOP runtime request failed: ${reason}`, undefined, "safe");
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    return { response, payload: await readJson(response) };
  }
}

function requestEnvelope(
  operation: StaffDeckSopOperation,
  payload: Record<string, unknown>,
  context: StaffDeckSopOperationContext | undefined,
): StaffDeckSopRequestEnvelope {
  const scope = context ?? {
    runId: `sop:${operation}`,
    operationId: `sop.${operation}`,
    requestId: `sop.${operation}`,
    sessionId: "unknown",
    turnId: "unknown",
  };
  return {
    protocolVersion: STAFFDECK_SOP_PROTOCOL_VERSION,
    runId: scope.runId,
    operationId: scope.operationId,
    requestId: scope.requestId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    ...(scope.idempotencyKey ? { idempotencyKey: scope.idempotencyKey } : {}),
    ...(scope.deadlineAt ? { deadlineAt: scope.deadlineAt } : {}),
    ...(scope.expectedRevision !== undefined ? { expectedRevision: scope.expectedRevision } : {}),
    payload,
  };
}

function validateManifest(value: unknown, expected?: SopRuntimeManifestExpectation): StaffDeckSopModuleManifest {
  const operations = isRecord(value) && Array.isArray(value.operations) ? value.operations : undefined;
  if (!isRecord(value)
    || value.status !== "ok"
    || value.protocolVersion !== STAFFDECK_SOP_PROTOCOL_VERSION
    || value.moduleId !== STAFFDECK_SOP_MODULE_ID
    || value.contract !== STAFFDECK_SOP_CONTRACT
    || !operations
    || !STAFFDECK_SOP_OPERATIONS.every((operation) => operations.includes(operation))) {
    throw new StaffDeckSopClientError(
      "SOP_PROTOCOL_INCOMPATIBLE",
      "StaffDeck SOP runtime does not advertise sop.runtime sop.lifecycle/v2 protocol 2.0 support.",
    );
  }
  if (expected && (value.descriptorVersion !== "1.0"
    || value.implementationId !== expected.implementationId
    || value.contract !== expected.contract
    || value.transport !== expected.transport)) {
    throw new StaffDeckSopClientError(
      "SOP_PROTOCOL_INCOMPATIBLE",
      `SOP runtime does not advertise the configured ${expected.implementationId} ${expected.contract}/${expected.transport} binding.`,
    );
  }
  return value as StaffDeckSopModuleManifest;
}

function validateResponseEnvelope(value: unknown, requestId: string): StaffDeckSopResponseEnvelope {
  if (!isRecord(value)
    || value.protocolVersion !== STAFFDECK_SOP_PROTOCOL_VERSION
    || value.requestId !== requestId
    || typeof value.ok !== "boolean"
    || (value.outcome !== "completed" && value.outcome !== "failed")) {
    throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime returned an invalid protocol envelope.");
  }
  if (value.ok) {
    if (value.outcome !== "completed" || !isRecord(value.payload)) {
      throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime returned an invalid success envelope.");
    }
  } else if (value.outcome !== "failed" || !isRuntimeError(value.error)) {
    throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime returned an invalid error envelope.");
  }
  return value as StaffDeckSopResponseEnvelope;
}

function validatePreparePayload(value: unknown): StaffDeckSopPrepareResponse {
  if (!isRecord(value) || !isSopState(value.state) || !isSopStep(value.step)) {
    throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime returned an invalid prepare payload.", undefined, "unsafe");
  }
  return value as StaffDeckSopPrepareResponse;
}

function validateSubmitPayload(value: unknown): StaffDeckSopSubmitResponse {
  if (!isRecord(value) || !isSopState(value.state) || !isSubmitResult(value.result)) {
    throw new StaffDeckSopClientError("SOP_RUNTIME_PROTOCOL", "StaffDeck SOP runtime returned an invalid submit payload.", undefined, "unsafe");
  }
  return value as StaffDeckSopSubmitResponse;
}

function isSopState(value: unknown): boolean {
  return isRecord(value);
}

function isSopStep(value: unknown): boolean {
  return isRecord(value)
    && typeof value.skillId === "string"
    && typeof value.skillName === "string"
    && typeof value.version === "string"
    && typeof value.nodeId === "string"
    && isRecord(value.node)
    && typeof value.instruction === "string"
    && isStringArray(value.expectedUserInfo)
    && isRecord(value.knownSlots)
    && isStringArray(value.allowedNextStepIds)
    && isStringArray(value.requiredToolNames)
    && isStringArray(value.allowedActions)
    && typeof value.isTerminal === "boolean"
    && typeof value.declaresHandoff === "boolean"
    && (value.subSopId === undefined || value.subSopId === null || typeof value.subSopId === "string");
}

function isSubmitResult(value: unknown): boolean {
  return isRecord(value)
    && typeof value.status === "string"
    && typeof value.replyFragment === "string"
    && isRecord(value.slotUpdates)
    // The StaffDeck owner serializes its optional summary as null when no
    // summary was supplied. Preserve that owner contract at the wire edge.
    && (value.taskSummary === undefined || value.taskSummary === null || typeof value.taskSummary === "string")
    && (value.nextStepId === undefined || value.nextStepId === null || typeof value.nextStepId === "string")
    && Array.isArray(value.events)
    && value.events.every(isRecord);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRuntimeError(value: unknown): value is NonNullable<StaffDeckSopResponseEnvelope["error"]> {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.message === "string"
    && (value.retryability === "safe" || value.retryability === "unsafe" || value.retryability === "retry_after_status")
    && (value.details === undefined || isRecord(value.details));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
