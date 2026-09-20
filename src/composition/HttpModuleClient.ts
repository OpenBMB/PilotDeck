import {
  MODULE_PROTOCOL_VERSION,
  validateModuleMessage,
  type ModuleCallRequest,
  type ModuleResponse,
} from "../agent/modules/protocol.js";
import type { ExternalModuleBinding } from "./types.js";

export type ModuleCallInput = Omit<ModuleCallRequest, "kind" | "messageId" | "method"> & {
  recordFailure?: boolean;
  /** Local cancellation is transport-only and is never serialized to a module. */
  abortSignal?: AbortSignal;
};

type ModuleManifest = {
  protocolVersion: typeof MODULE_PROTOCOL_VERSION;
  implementationId: string;
  contract: string;
  transport: string;
  methods: string[];
};

export class HttpModuleClient {
  private manifestPromise?: Promise<ModuleManifest>;
  private sequence = 0;

  constructor(
    private readonly binding: ExternalModuleBinding,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  call = async (input: ModuleCallInput): Promise<ModuleResponse> => {
    await this.manifest();
    const messageId = `module-http-${++this.sequence}`;
    const { recordFailure: _recordFailure, abortSignal, ...requestInput } = input;
    const request: ModuleCallRequest = {
      kind: "request",
      method: "module_call",
      messageId,
      ...requestInput,
    };
    const response = await this.requestJson(this.binding.callPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, true, abortSignal);
    const validation = validateModuleMessage(response);
    if (!validation.ok || !isModuleResponse(response)) {
      throw protocolError(validation.ok ? "Module call did not return a response envelope." : validation.message);
    }
    validateResponseSemantics(response);
    if (response.inReplyTo !== messageId || (response.requestId !== undefined && response.requestId !== input.requestId)) {
      throw protocolError("Module response correlation does not match the request.");
    }
    return response;
  };

  async manifest(): Promise<ModuleManifest> {
    this.manifestPromise ??= this.loadManifest().catch((error) => {
      this.manifestPromise = undefined;
      throw error;
    });
    return this.manifestPromise;
  }

  private async loadManifest(): Promise<ModuleManifest> {
    const value = await this.requestJson(this.binding.manifestPath, { method: "GET" });
    if (!isRecord(value)) throw protocolError("Module manifest must be an object.");
    if (
      value.protocolVersion !== MODULE_PROTOCOL_VERSION
      || value.implementationId !== this.binding.implementationId
      || value.contract !== this.binding.contract
      || value.transport !== this.binding.transport
      || !Array.isArray(value.methods)
      || !value.methods.every((method) => typeof method === "string")
    ) {
      throw protocolError("Module manifest identity, protocol, contract, transport, or methods are incompatible.");
    }
    const methods = value.methods as string[];
    const missing = this.binding.methods.find((method) => !methods.includes(method));
    if (missing) throw protocolError(`Module manifest does not provide required method '${missing}'.`);
    return {
      protocolVersion: MODULE_PROTOCOL_VERSION,
      implementationId: this.binding.implementationId,
      contract: this.binding.contract,
      transport: this.binding.transport,
      methods,
    };
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    acceptStructuredError = false,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    if (callerSignal?.aborted) throw transportError("MODULE_ABORTED", "Module request was cancelled before dispatch.");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.binding.timeoutMs ?? 10_000);
    const abortForCaller = () => controller.abort();
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
    try {
      const response = await this.fetchImpl(new URL(path, ensureTrailingSlash(this.binding.endpoint)), {
        ...init,
        signal: controller.signal,
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok && !(acceptStructuredError && isModuleResponse(value) && value.ok === false)) {
        throw new Error(`Module HTTP request failed with status ${response.status}.`);
      }
      if (value === undefined) throw protocolError("Module HTTP response must contain JSON.");
      return value;
    } catch (error) {
      if (timedOut) {
        throw transportError("MODULE_TIMEOUT", `Module HTTP request exceeded ${this.binding.timeoutMs ?? 10_000}ms.`);
      }
      if (callerSignal?.aborted || controller.signal.aborted) {
        throw transportError("MODULE_ABORTED", "Module request was cancelled.");
      }
      if (isModuleError(error)) throw error;
      throw transportError("MODULE_TRANSPORT_UNAVAILABLE", "Module HTTP request could not be completed.");
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortForCaller);
    }
  }
}

function isModuleResponse(value: unknown): value is ModuleResponse {
  return isRecord(value) && value.kind === "response";
}

function validateResponseSemantics(response: ModuleResponse): void {
  if (response.ok) {
    if (response.code !== undefined || response.error !== undefined || response.outcome === "failed") {
      throw protocolError("Successful module response contains failure fields.");
    }
    return;
  }
  if (typeof response.code !== "string" || !response.code || !isRecord(response.error)) {
    throw protocolError("Failed module response requires code and error details.");
  }
  if (
    response.error.code !== response.code
    || typeof response.error.message !== "string"
    || !response.error.message
    || !["safe", "unsafe", "retry_after_status"].includes(String(response.error.retryability))
  ) {
    throw protocolError("Failed module response error fields are inconsistent.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function protocolError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "MODULE_PROTOCOL_INCOMPATIBLE" });
}

function transportError(code: "MODULE_ABORTED" | "MODULE_TIMEOUT" | "MODULE_TRANSPORT_UNAVAILABLE", message: string): Error & { code: string; outcome: "result_unknown" } {
  return Object.assign(new Error(message), { code, outcome: "result_unknown" as const });
}

function isModuleError(value: unknown): value is Error & { code?: string } {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string";
}
