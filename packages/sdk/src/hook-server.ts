import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { PilotDeckError } from "./types.js";
import type {
  PilotDeckHookCallbackMatcher,
  PilotDeckHookCallback,
  PilotDeckHookEvent,
  PilotDeckHookAsyncJSONOutput,
  PilotDeckHookInput,
  PilotDeckHookJSONOutput,
  PilotDeckHookSyncJSONOutput,
  PilotDeckHookServerStartOptions,
  PilotDeckHooks,
} from "./types.js";

export type HostedHookConfig = {
  url: string;
  headers: Record<string, string>;
  events: Partial<Record<PilotDeckHookEvent, Array<{ matcher?: string; timeout?: number }>>>;
};

const NATIVE_HOOK_EVENTS = new Set<PilotDeckHookEvent>([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit",
  "PreModelRequest", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart",
  "SubagentStop", "PreCompact", "PostCompact", "PermissionRequest", "PermissionDenied",
  "Setup", "ConfigChange", "InstructionsLoaded", "FileChanged", "Elicitation", "ElicitationResult",
]);

const UNSUPPORTED_HOOK_EVENTS: Partial<Record<PilotDeckHookEvent, string>> = {
  Notification: "PilotDeck has no user-notification lifecycle event; Gateway notifications are infrastructure frames, not hooks.",
  CwdChanged: "PilotDeck sessions have a fixed working directory; in-session cwd changes have no native lifecycle event.",
  WorktreeCreate: "PilotDeck only emits this from the Always-On workspace runtime; it is not attached to a per-query Gateway session.",
  WorktreeRemove: "PilotDeck only emits this from the Always-On workspace runtime; it is not attached to a per-query Gateway session.",
};

/**
 * Bridges serializable Gateway HTTP-hook configuration to the non-serializable
 * callbacks supplied by the SDK caller. The native HookRuntime remains the
 * authority for event timing, matchers and lifecycle effects.
 */
export class HostedHookServer {
  private httpServer?: HttpServer;
  private endpoint?: HostedHookConfig;
  private startPromise?: Promise<HostedHookConfig>;
  private readonly activeCalls = new Set<AbortController>();
  private path = "/pilotdeck-sdk-hooks";
  private token = "";

  constructor(private readonly hooks: PilotDeckHooks) {
    for (const [event, matchers] of Object.entries(hooks)) {
      const unsupportedMessage = UNSUPPORTED_HOOK_EVENTS[event as PilotDeckHookEvent];
      if (unsupportedMessage) {
        throw new PilotDeckError({
          code: "unsupported_capability",
          message: `hooks.${event} is unsupported: ${unsupportedMessage}`,
        });
      }
      if (!NATIVE_HOOK_EVENTS.has(event as PilotDeckHookEvent)) {
        throw new PilotDeckError({
          code: "unsupported_capability",
          message: `hooks.${event} has no native PilotDeck lifecycle event.`,
        });
      }
      if (!Array.isArray(matchers) || matchers.some((matcher) => !matcher || !Array.isArray(matcher.hooks) || matcher.hooks.some((hook) => typeof hook !== "function"))) {
        throw new PilotDeckError({ code: "validation_error", message: `hooks.${event} must contain callback matchers with hooks arrays.` });
      }
    }
  }

  async start(options: PilotDeckHookServerStartOptions = {}): Promise<HostedHookConfig> {
    if (!this.startPromise) this.startPromise = this.startInternal(options);
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this.endpoint = undefined;
    this.startPromise = undefined;
    for (const controller of this.activeCalls) controller.abort();
    this.activeCalls.clear();
    await closeHttpServer(server);
  }

  private async startInternal(options: PilotDeckHookServerStartOptions): Promise<HostedHookConfig> {
    this.path = normalizePath(options.path);
    this.token = randomUUID();
    const host = options.host ?? "127.0.0.1";
    const server = createServer((request, response) => { void this.handleRequest(request, response); });
    try {
      await listen(server, options.port ?? 0, host);
      const address = server.address();
      if (!address || typeof address === "string") throw new PilotDeckError({ code: "server_error", message: "SDK hook server did not expose a TCP address." });
      const localUrl = `http://${formatHost(address.address)}:${address.port}${this.path}`;
      const url = options.publicUrl ? normalizePublicEndpoint(options.publicUrl) : localUrl;
      this.httpServer = server;
      this.endpoint = {
        url,
        headers: { authorization: `Bearer ${this.token}` },
        events: Object.fromEntries(Object.entries(this.hooks).map(([event, matchers]) => [
          event,
          (matchers ?? []).map((matcher) => ({
            ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
            ...(matcher.timeout !== undefined ? { timeout: matcher.timeout } : {}),
          })),
        ])),
      } as HostedHookConfig;
      return cloneConfig(this.endpoint);
    } catch (cause) {
      await closeHttpServer(server);
      throw cause instanceof PilotDeckError
        ? cause
        : new PilotDeckError({ code: "server_error", message: `Unable to start SDK hook server: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || !request.url || new URL(request.url, "http://localhost").pathname !== this.path) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "PilotDeck SDK hook endpoint not found." }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized PilotDeck SDK hook request." }));
      return;
    }
    const query = new URL(request.url, "http://localhost").searchParams;
    const event = query.get("event") as PilotDeckHookEvent | null;
    const matcherIndex = Number(query.get("matcher"));
    const matchers = event ? this.hooks[event] : undefined;
    const matcher = Number.isInteger(matcherIndex) && matcherIndex >= 0 ? matchers?.[matcherIndex] : undefined;
    if (!event || !matcher) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid SDK hook endpoint selector." }));
      return;
    }
    const controller = new AbortController();
    this.activeCalls.add(controller);
    const onClose = () => controller.abort();
    request.once("aborted", onClose);
    response.once("close", onClose);
    try {
      const input = toSdkHookInput(await readJsonBody(request));
      const asyncHookId = randomUUID();
      const matcherOutput = await this.runMatcher(matcher, input, controller.signal, asyncHookId);
      const output = matcherOutput.async === true
        ? toDeferredHookOutput(matcherOutput, asyncHookId)
        : toNativeHookOutput(matcherOutput, event);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(output));
    } catch (cause) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: cause instanceof Error ? cause.message : "SDK hook callback failed.",
        ...(cause instanceof PilotDeckError ? { code: cause.code } : {}),
      }));
    } finally {
      request.off("aborted", onClose);
      response.off("close", onClose);
      this.activeCalls.delete(controller);
    }
  }

  private async runMatcher(
    matcher: PilotDeckHookCallbackMatcher,
    input: PilotDeckHookInput,
    signal: AbortSignal,
    asyncHookId: string,
  ): Promise<PilotDeckHookJSONOutput> {
    let merged: PilotDeckHookSyncJSONOutput = {};
    let deferred: PilotDeckHookAsyncJSONOutput | undefined;
    const toolUseId = typeof input.tool_use_id === "string"
      ? input.tool_use_id
      : typeof input.tool_call_id === "string" ? input.tool_call_id : undefined;
    for (const callback of matcher.hooks) {
      const output = await invokeCallback(
        callback,
        input,
        toolUseId,
        matcher.timeout,
        signal,
        asyncHookId,
      );
      if (!output) continue;
      if (output.async === true) {
        if (deferred || hasSyncHookOutput(merged)) {
          throw new PilotDeckError({
            code: "validation_error",
            message: "A hook matcher cannot combine an async output with synchronous hook effects.",
          });
        }
        validateAsyncHookOutput(output);
        deferred = output;
        continue;
      }
      if (deferred) {
        throw new PilotDeckError({
          code: "validation_error",
          message: "A hook matcher cannot combine an async output with synchronous hook effects.",
        });
      }
      merged = mergeOutput(merged, output);
    }
    return deferred ?? merged;
  }
}

function toSdkHookInput(value: unknown): PilotDeckHookInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotDeckError({ code: "validation_error", message: "SDK hook payload must be an object." });
  }
  const input = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [camelToSnake(key), item]),
  ) as Record<string, unknown>;
  if (typeof input.hook_event_name !== "string" || !NATIVE_HOOK_EVENTS.has(input.hook_event_name as PilotDeckHookEvent)) {
    throw new PilotDeckError({ code: "validation_error", message: "SDK hook payload has no supported native hook_event_name." });
  }
  if (typeof input.session_id !== "string" || typeof input.transcript_path !== "string" || typeof input.cwd !== "string") {
    throw new PilotDeckError({ code: "validation_error", message: "SDK hook payload is missing session_id, transcript_path, or cwd." });
  }
  return input as PilotDeckHookInput;
}

function toDeferredHookOutput(
  output: PilotDeckHookAsyncJSONOutput,
  asyncHookId: string,
): PilotDeckHookAsyncJSONOutput & { asyncHookId: string } {
  return {
    async: true,
    asyncHookId,
    ...(output.asyncTimeout !== undefined ? { asyncTimeout: output.asyncTimeout } : {}),
  };
}

function toNativeHookOutput(output: PilotDeckHookSyncJSONOutput, event: PilotDeckHookEvent): PilotDeckHookSyncJSONOutput {
  const specific = output.hookSpecificOutput;
  if (!specific) return output;
  if (specific.hookEventName !== event) {
    throw new PilotDeckError({
      code: "validation_error",
      message: `Hook ${event} returned hookSpecificOutput for ${specific.hookEventName}.`,
    });
  }
  return {
    ...output,
    hookSpecificOutput: {
      ...specific,
      ...(specific.permissionDecision === "defer" ? { permissionDecision: "passthrough" } : {}),
    },
  } as PilotDeckHookSyncJSONOutput;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function mergeOutput(previous: PilotDeckHookSyncJSONOutput, next: PilotDeckHookSyncJSONOutput): PilotDeckHookSyncJSONOutput {
  const previousSpecific = previous.hookSpecificOutput;
  const nextSpecific = next.hookSpecificOutput;
  const hookSpecificOutput = previousSpecific
    ? (nextSpecific ? { ...previousSpecific, ...nextSpecific } : previousSpecific)
    : nextSpecific;
  return {
    ...previous,
    ...next,
    // A prior block cannot be undone by a later callback in the same matcher.
    ...(previous.continue === false || next.continue === false ? { continue: false } : {}),
    ...(previous.decision === "block" || next.decision === "block" ? { decision: "block" } : {}),
    ...(previous.systemMessage && next.systemMessage ? { systemMessage: `${previous.systemMessage}\n${next.systemMessage}` } : {}),
    ...(hookSpecificOutput ? { hookSpecificOutput } : {}),
  };
}

function hasSyncHookOutput(output: PilotDeckHookSyncJSONOutput): boolean {
  return Object.keys(output).length > 0;
}

function validateAsyncHookOutput(output: PilotDeckHookAsyncJSONOutput): void {
  if (output.asyncTimeout !== undefined
    && (!Number.isFinite(output.asyncTimeout) || output.asyncTimeout <= 0)) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "asyncTimeout must be a positive finite number of seconds.",
    });
  }
}

async function invokeCallback(
  callback: PilotDeckHookCallback,
  input: PilotDeckHookInput,
  toolUseId: string | undefined,
  seconds: number | undefined,
  parentSignal: AbortSignal,
  asyncHookId: string,
): Promise<PilotDeckHookJSONOutput | void> {
  if (parentSignal.aborted) throw new PilotDeckError({ code: "transport_error", message: "SDK hook callback was aborted." });
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new PilotDeckError({ code: "validation_error", message: "Hook matcher timeout must be a positive finite number of seconds." });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const promise = Promise.resolve(callback(input, toolUseId, {
    signal: controller.signal,
    asyncHookId,
  }));
  if (seconds === undefined) {
    try { return await promise; }
    finally { parentSignal.removeEventListener("abort", abort); }
  }
  return new Promise<PilotDeckHookJSONOutput | void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
      parentSignal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: PilotDeckHookJSONOutput | void) => { cleanup(); resolve(value); };
    const finishReject = (error: unknown) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      controller.abort();
      finishReject(new PilotDeckError({ code: "timeout", message: `SDK hook callback timed out after ${seconds}s.` }));
    }, seconds * 1_000);
    const onAbort = () => finishReject(new PilotDeckError({ code: "transport_error", message: "SDK hook callback was aborted." }));
    parentSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(finishResolve, finishReject);
  });
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new PilotDeckError({ code: "validation_error", message: "SDK hook payload exceeds 1MB." }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new PilotDeckError({ code: "validation_error", message: "SDK hook payload is not valid JSON." })); }
    });
  });
}

function normalizePath(value: string | undefined): string {
  const path = value ?? "/pilotdeck-sdk-hooks";
  if (!path.startsWith("/")) throw new PilotDeckError({ code: "validation_error", message: "Hook endpoint path must begin with '/'." });
  return path;
}

function normalizePublicEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new PilotDeckError({ code: "validation_error", message: "Hook publicUrl must be an absolute HTTP(S) endpoint URL." }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PilotDeckError({ code: "validation_error", message: "Hook publicUrl must use http: or https:." });
  return url.toString();
}

function formatHost(host: string): string { return host.includes(":") ? `[${host}]` : host; }

function cloneConfig(config: HostedHookConfig): HostedHookConfig {
  return { url: config.url, headers: { ...config.headers }, events: structuredClone(config.events) };
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  (server as HttpServer & { closeIdleConnections?: () => void }).closeIdleConnections?.();
  (server as HttpServer & { closeAllConnections?: () => void }).closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
