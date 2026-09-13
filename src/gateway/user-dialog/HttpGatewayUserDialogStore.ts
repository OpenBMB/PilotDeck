import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GatewayUserDialogRequestEvent } from "../protocol/types.js";
import type {
  GatewayStoredUserDialog,
  GatewayStoredUserDialogAnswer,
  GatewayStoredUserDialogLeaseClaim,
  GatewayStoredUserDialogOwnerClaim,
  GatewayStoredUserDialogResult,
  GatewayUserDialogStore,
  GatewayUserDialogStoreKey,
} from "./GatewayUserDialogStore.js";

const HTTP_STORE_VERSION = 1 as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const STORE_PATH_PREFIX = "/v1/gateway-user-dialog-store/";

type LiveGatewayUserDialogStore = Required<GatewayUserDialogStore>;
type HttpStoreOperation =
  | "put"
  | "list"
  | "remove"
  | "clear"
  | "listLive"
  | "claimLive"
  | "releaseLive"
  | "submitLiveAnswer"
  | "takeLiveAnswer"
  | "claimLiveOwner"
  | "renewLiveOwner"
  | "releaseLiveOwner";

type HttpStoreRequest = {
  version: typeof HTTP_STORE_VERSION;
  key: GatewayUserDialogStoreKey;
  dialog?: GatewayStoredUserDialog;
  requestId?: string;
  input?: Record<string, unknown>;
};

type HttpStoreResponse = {
  version: typeof HTTP_STORE_VERSION;
  result: unknown;
};

export type HttpGatewayUserDialogStoreOptions = {
  /** Base URL of a `GatewayUserDialogStoreHttpServer`; never supplied by SDK wire. */
  url: string;
  /** Required host-to-host bearer token. It is not an SDK credential. */
  authorizationToken: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * Distributed implementation of the complete Gateway user-dialog store
 * protocol. It lets Gateway hosts on separate machines use one durable,
 * host-owned store service without transferring AgentLoop state to a client.
 */
export class HttpGatewayUserDialogStore implements LiveGatewayUserDialogStore {
  private readonly endpoint: URL;
  private readonly authorizationToken: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpGatewayUserDialogStoreOptions) {
    this.endpoint = normalizeEndpoint(options.url);
    if (!options.authorizationToken?.trim()) {
      throw new TypeError("HttpGatewayUserDialogStore authorizationToken is required.");
    }
    this.authorizationToken = options.authorizationToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") throw new TypeError("HttpGatewayUserDialogStore requires fetch.");
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  }

  async put(key: GatewayUserDialogStoreKey, dialog: GatewayStoredUserDialog): Promise<void> {
    await this.call("put", { key, dialog });
  }

  async list(key: GatewayUserDialogStoreKey): Promise<readonly GatewayStoredUserDialog[]> {
    return assertDialogs(await this.call("list", { key }));
  }

  async remove(key: GatewayUserDialogStoreKey, requestId: string): Promise<void> {
    await this.call("remove", { key, requestId });
  }

  async clear(key: GatewayUserDialogStoreKey): Promise<void> {
    await this.call("clear", { key });
  }

  async listLive(key: GatewayUserDialogStoreKey): Promise<readonly GatewayStoredUserDialog[]> {
    return assertDialogs(await this.call("listLive", { key }));
  }

  async claimLive(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ttlMs: number; leaseId?: string },
  ): Promise<GatewayStoredUserDialogLeaseClaim> {
    return assertLeaseClaim(await this.call("claimLive", { key, input }));
  }

  async releaseLive(key: GatewayUserDialogStoreKey, input: { requestId: string; leaseId: string }): Promise<boolean> {
    return assertBoolean(await this.call("releaseLive", { key, input }));
  }

  async submitLiveAnswer(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; leaseId?: string; result: GatewayStoredUserDialogResult },
  ): Promise<boolean> {
    return assertBoolean(await this.call("submitLiveAnswer", { key, input }));
  }

  async takeLiveAnswer(key: GatewayUserDialogStoreKey, requestId: string): Promise<GatewayStoredUserDialogAnswer | undefined> {
    return assertAnswer(await this.call("takeLiveAnswer", { key, requestId }));
  }

  async claimLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string; ttlMs: number },
  ): Promise<GatewayStoredUserDialogOwnerClaim> {
    return assertOwnerClaim(await this.call("claimLiveOwner", { key, input }));
  }

  async renewLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string; ttlMs: number },
  ): Promise<boolean> {
    return assertBoolean(await this.call("renewLiveOwner", { key, input }));
  }

  async releaseLiveOwner(
    key: GatewayUserDialogStoreKey,
    input: { requestId: string; ownerId: string },
  ): Promise<boolean> {
    return assertBoolean(await this.call("releaseLiveOwner", { key, input }));
  }

  private async call(operation: HttpStoreOperation, payload: Omit<HttpStoreRequest, "version">): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("gateway_user_dialog_store_timeout"), this.timeoutMs);
    try {
      const response = await this.fetch(new URL(operation, this.endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authorizationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: HTTP_STORE_VERSION, ...payload }),
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        const message = isRecord(responseBody) && typeof responseBody.message === "string"
          ? responseBody.message
          : `HTTP ${response.status}`;
        throw new Error(`Gateway user-dialog store ${operation} failed: ${message}`);
      }
      if (!isRecord(responseBody) || responseBody.version !== HTTP_STORE_VERSION || !Object.prototype.hasOwnProperty.call(responseBody, "result")) {
        throw new Error(`Gateway user-dialog store ${operation} returned an invalid response.`);
      }
      return responseBody.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type GatewayUserDialogStoreHttpHandlerOptions = {
  store: GatewayUserDialogStore;
  /** Required shared secret for host-to-host requests. */
  authorizationToken: string;
};

/** Framework-neutral Request/Response handler for a durable dialog-store service. */
export type GatewayUserDialogStoreHttpHandler = (request: Request) => Promise<Response>;

/**
 * Creates a versioned handler for the full live store protocol. The backing
 * store can be a FileGatewayUserDialogStore on a dedicated host or a custom
 * transactional database implementation. All participating Gateway hosts
 * use HttpGatewayUserDialogStore to reach this one authority.
 */
export function createGatewayUserDialogStoreHttpHandler(
  options: GatewayUserDialogStoreHttpHandlerOptions,
): GatewayUserDialogStoreHttpHandler {
  const store = requireLiveStore(options.store);
  if (!options.authorizationToken?.trim()) {
    throw new TypeError("Gateway user-dialog store HTTP authorizationToken is required.");
  }
  const token = options.authorizationToken;
  return async (request) => {
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Only POST is supported.");
    const operation = operationFromRequest(request.url);
    if (!operation) return errorResponse(404, "not_found", "Unknown Gateway user-dialog store operation.");
    if (!tokensMatch(request.headers.get("authorization"), token)) {
      return errorResponse(401, "unauthorized", "Gateway user-dialog store authorization failed.");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON.");
    }
    try {
      const input = parseRequest(body);
      const result = await dispatchStoreOperation(store, operation, input);
      return jsonResponse(200, { version: HTTP_STORE_VERSION, result } satisfies HttpStoreResponse);
    } catch (error) {
      return errorResponse(
        error instanceof HttpStoreValidationError ? 400 : 500,
        error instanceof HttpStoreValidationError ? error.code : "store_failure",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

export type GatewayUserDialogStoreHttpServerOptions = GatewayUserDialogStoreHttpHandlerOptions & {
  host?: string;
  port?: number;
};

export type GatewayUserDialogStoreHttpServer = {
  url: string;
  close(): Promise<void>;
};

/** Small Node host for the framework-neutral handler, useful for an isolated store service. */
export async function startGatewayUserDialogStoreHttpServer(
  options: GatewayUserDialogStoreHttpServerOptions,
): Promise<GatewayUserDialogStoreHttpServer> {
  const handler = createGatewayUserDialogStoreHttpHandler(options);
  const server = createServer((request, response) => {
    void serveNodeRequest(handler, request, response);
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Gateway user-dialog store HTTP server did not expose a TCP address.");
  }
  return {
    url: `http://${host}:${address.port}${STORE_PATH_PREFIX}`,
    close: () => closeServer(server),
  };
}

async function dispatchStoreOperation(
  store: LiveGatewayUserDialogStore,
  operation: HttpStoreOperation,
  request: HttpStoreRequest,
): Promise<unknown> {
  switch (operation) {
    case "put":
      await store.put(request.key, requiredDialog(request.dialog));
      return null;
    case "list":
      return store.list(request.key);
    case "remove":
      await store.remove(request.key, requiredString(request.requestId, "requestId"));
      return null;
    case "clear":
      await store.clear(request.key);
      return null;
    case "listLive":
      return store.listLive(request.key);
    case "claimLive":
      return store.claimLive(request.key, parseClaimInput(request.input));
    case "releaseLive":
      return store.releaseLive(request.key, parseReleaseInput(request.input));
    case "submitLiveAnswer":
      return store.submitLiveAnswer(request.key, parseAnswerInput(request.input));
    case "takeLiveAnswer":
      return (await store.takeLiveAnswer(request.key, requiredString(request.requestId, "requestId"))) ?? null;
    case "claimLiveOwner":
      return store.claimLiveOwner(request.key, parseOwnerRenewInput(request.input));
    case "renewLiveOwner":
      return store.renewLiveOwner(request.key, parseOwnerRenewInput(request.input));
    case "releaseLiveOwner":
      return store.releaseLiveOwner(request.key, parseOwnerReleaseInput(request.input));
  }
}

function requireLiveStore(store: GatewayUserDialogStore): LiveGatewayUserDialogStore {
  const methods: Array<keyof GatewayUserDialogStore> = [
    "put", "list", "remove", "clear", "listLive", "claimLive", "releaseLive",
    "submitLiveAnswer", "takeLiveAnswer", "claimLiveOwner", "renewLiveOwner", "releaseLiveOwner",
  ];
  for (const method of methods) {
    if (typeof store[method] !== "function") {
      throw new TypeError(`Gateway user-dialog store HTTP service requires ${method}().`);
    }
  }
  return store as LiveGatewayUserDialogStore;
}

function parseRequest(value: unknown): HttpStoreRequest {
  if (!isRecord(value) || value.version !== HTTP_STORE_VERSION) {
    throw new HttpStoreValidationError("invalid_request", "Request must use gateway user-dialog store schema version 1.");
  }
  return {
    version: HTTP_STORE_VERSION,
    key: parseStoreKey(value.key),
    ...(value.dialog !== undefined ? { dialog: requiredDialog(value.dialog) } : {}),
    ...(value.requestId !== undefined ? { requestId: requiredString(value.requestId, "requestId") } : {}),
    ...(value.input !== undefined ? { input: requiredRecord(value.input, "input") } : {}),
  };
}

function parseStoreKey(value: unknown): GatewayUserDialogStoreKey {
  const key = requiredRecord(value, "key");
  return {
    projectRoot: requiredString(key.projectRoot, "key.projectRoot"),
    pilotHome: requiredString(key.pilotHome, "key.pilotHome"),
    sessionId: requiredString(key.sessionId, "key.sessionId"),
  };
}

function requiredDialog(value: unknown): GatewayStoredUserDialog {
  const dialog = requiredRecord(value, "dialog");
  const request = requiredRecord(dialog.request, "dialog.request");
  if (request.type !== "user_dialog_request") {
    throw new HttpStoreValidationError("invalid_dialog", "dialog.request must be a user_dialog_request.");
  }
  requiredString(request.requestId, "dialog.request.requestId");
  requiredString(request.toolCallId, "dialog.request.toolCallId");
  requiredString(request.toolName, "dialog.request.toolName");
  requiredString(request.prompt, "dialog.request.prompt");
  if (request.dialogKind !== "input" && request.dialogKind !== "select" && request.dialogKind !== "confirm" && request.dialogKind !== "form") {
    throw new HttpStoreValidationError("invalid_dialog", "dialog.request.dialogKind is invalid.");
  }
  return {
    request: structuredClone(request) as GatewayUserDialogRequestEvent,
    createdAt: requiredString(dialog.createdAt, "dialog.createdAt"),
  };
}

function parseClaimInput(value: Record<string, unknown> | undefined): { requestId: string; ttlMs: number; leaseId?: string } {
  const input = requiredRecord(value, "input");
  return {
    requestId: requiredString(input.requestId, "input.requestId"),
    ttlMs: positiveInteger(input.ttlMs, undefined, "input.ttlMs"),
    ...(input.leaseId !== undefined ? { leaseId: requiredString(input.leaseId, "input.leaseId") } : {}),
  };
}

function parseReleaseInput(value: Record<string, unknown> | undefined): { requestId: string; leaseId: string } {
  const input = requiredRecord(value, "input");
  return {
    requestId: requiredString(input.requestId, "input.requestId"),
    leaseId: requiredString(input.leaseId, "input.leaseId"),
  };
}

function parseAnswerInput(value: Record<string, unknown> | undefined): {
  requestId: string;
  leaseId?: string;
  result: GatewayStoredUserDialogResult;
} {
  const input = requiredRecord(value, "input");
  const result = requiredRecord(input.result, "input.result");
  if (result.behavior === "answered") {
    return {
      requestId: requiredString(input.requestId, "input.requestId"),
      ...(input.leaseId !== undefined ? { leaseId: requiredString(input.leaseId, "input.leaseId") } : {}),
      result: { behavior: "answered", value: structuredClone(result.value) },
    };
  }
  if (result.behavior === "cancelled") {
    return {
      requestId: requiredString(input.requestId, "input.requestId"),
      ...(input.leaseId !== undefined ? { leaseId: requiredString(input.leaseId, "input.leaseId") } : {}),
      result: {
        behavior: "cancelled",
        ...(result.reason !== undefined ? { reason: requiredString(result.reason, "input.result.reason") } : {}),
      },
    };
  }
  throw new HttpStoreValidationError("invalid_dialog_result", "input.result must be answered or cancelled.");
}

function parseOwnerRenewInput(value: Record<string, unknown> | undefined): { requestId: string; ownerId: string; ttlMs: number } {
  const input = requiredRecord(value, "input");
  return {
    requestId: requiredString(input.requestId, "input.requestId"),
    ownerId: requiredString(input.ownerId, "input.ownerId"),
    ttlMs: positiveInteger(input.ttlMs, undefined, "input.ttlMs"),
  };
}

function parseOwnerReleaseInput(value: Record<string, unknown> | undefined): { requestId: string; ownerId: string } {
  const input = requiredRecord(value, "input");
  return {
    requestId: requiredString(input.requestId, "input.requestId"),
    ownerId: requiredString(input.ownerId, "input.ownerId"),
  };
}

function assertDialogs(value: unknown): readonly GatewayStoredUserDialog[] {
  if (!Array.isArray(value)) throw new Error("Gateway user-dialog store returned invalid dialog records.");
  return value.map((dialog) => requiredDialog(dialog));
}

function assertLeaseClaim(value: unknown): GatewayStoredUserDialogLeaseClaim {
  const claim = requiredRecord(value, "response.claim");
  if (claim.claimed === true) {
    return {
      claimed: true,
      leaseId: requiredString(claim.leaseId, "response.claim.leaseId"),
      expiresAt: requiredString(claim.expiresAt, "response.claim.expiresAt"),
    };
  }
  if (claim.claimed === false && (claim.reason === "claimed" || claim.reason === "not_pending")) {
    return {
      claimed: false,
      reason: claim.reason,
      ...(claim.expiresAt !== undefined ? { expiresAt: requiredString(claim.expiresAt, "response.claim.expiresAt") } : {}),
    };
  }
  throw new Error("Gateway user-dialog store returned an invalid lease claim.");
}

function assertOwnerClaim(value: unknown): GatewayStoredUserDialogOwnerClaim {
  const claim = requiredRecord(value, "response.ownerClaim");
  if (claim.owned === true) {
    return {
      owned: true,
      ownerId: requiredString(claim.ownerId, "response.ownerClaim.ownerId"),
      expiresAt: requiredString(claim.expiresAt, "response.ownerClaim.expiresAt"),
    };
  }
  if (claim.owned === false && (claim.reason === "owned" || claim.reason === "not_pending")) {
    return {
      owned: false,
      reason: claim.reason,
      ...(claim.expiresAt !== undefined ? { expiresAt: requiredString(claim.expiresAt, "response.ownerClaim.expiresAt") } : {}),
    };
  }
  throw new Error("Gateway user-dialog store returned an invalid owner claim.");
}

function assertAnswer(value: unknown): GatewayStoredUserDialogAnswer | undefined {
  if (value === null) return undefined;
  const answer = requiredRecord(value, "response.answer");
  return {
    requestId: requiredString(answer.requestId, "response.answer.requestId"),
    submittedAt: requiredString(answer.submittedAt, "response.answer.submittedAt"),
    result: parseAnswerInput({ requestId: answer.requestId, result: answer.result }).result,
  };
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Gateway user-dialog store returned an invalid boolean result.");
  return value;
}

function operationFromRequest(url: string): HttpStoreOperation | undefined {
  const path = new URL(url).pathname;
  if (!path.startsWith(STORE_PATH_PREFIX)) return undefined;
  const operation = path.slice(STORE_PATH_PREFIX.length);
  return isOperation(operation) ? operation : undefined;
}

function normalizeEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("HttpGatewayUserDialogStore url must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("HttpGatewayUserDialogStore url must use HTTP(S).");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

function isOperation(value: string): value is HttpStoreOperation {
  return value === "put" || value === "list" || value === "remove" || value === "clear"
    || value === "listLive" || value === "claimLive" || value === "releaseLive"
    || value === "submitLiveAnswer" || value === "takeLiveAnswer"
    || value === "claimLiveOwner" || value === "renewLiveOwner" || value === "releaseLiveOwner";
}

function tokensMatch(authorization: string | null, expected: string): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { version: HTTP_STORE_VERSION, error: code, message });
}

async function serveNodeRequest(
  handler: GatewayUserDialogStoreHttpHandler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const host = request.headers.host ?? "localhost";
    const protocol = (request.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    const result = await handler(new Request(`${protocol}://${host}${request.url ?? "/"}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    }));
    response.statusCode = result.status;
    for (const [name, value] of result.headers) response.setHeader(name, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    const result = errorResponse(500, "server_failure", error instanceof Error ? error.message : String(error));
    response.statusCode = result.status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(Buffer.from(await result.arrayBuffer()));
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpStoreValidationError("invalid_request", `${label} must be an object.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpStoreValidationError("invalid_request", `${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number | undefined, label: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new HttpStoreValidationError("invalid_request", `${label} must be a positive safe integer.`);
  }
  return resolved;
}

class HttpStoreValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
