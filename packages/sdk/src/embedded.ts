import { randomUUID } from "node:crypto";
import {
  createPilotDeckClientWithTransportFactory,
  createQueryWithTransport,
  createWarmQueryWithTransport,
  toEmbeddedTool,
} from "./client.js";
import {
  AsyncEventQueue,
  mapError,
  type GatewayTransportClient,
  type GatewayTransportNotificationListener,
} from "./transport.js";
import {
  PilotDeckError,
  type PilotDeckEmbeddedToolDefinition,
  type PilotDeckClient,
  type PilotDeckMessage,
  type PilotDeckOptions,
  type PilotDeckQuery,
  type PilotDeckServerInfo,
  type PilotDeckToolDefinition,
  type PilotDeckUserMessage,
  type PilotDeckWarmQuery,
} from "./types.js";

/**
 * Embedded spelling for the host-backed SDK event-mirror adapter. It does not
 * replace Gateway transcript or checkpoint storage.
 */
export { createSessionStoreFromAdapter as createEmbeddedSessionStore } from "./session-store.js";
export type { SessionStorePersistenceAdapter as PilotDeckEmbeddedSessionStoreAdapter } from "./session-store.js";

/**
 * The narrow host capability needed to publish local SDK tools into an
 * in-process `createLocalGateway()` runtime. It intentionally exposes no
 * AgentLoop, session, permission, or storage internals.
 */
export type PilotDeckEmbeddedGatewayHost = {
  /**
   * Deliberately untyped at the package boundary: `createLocalGateway` owns
   * the native ToolDefinition schema and is not a dependency of this SDK
   * package. Values originate exclusively from `toEmbeddedTool()` below.
   */
  updateSubsystems(update: { extraTools: any[] }): void;
};

export type PilotDeckEmbeddedToolRegistryOptions = {
  tools?: PilotDeckToolDefinition[];
};

/**
 * A local Gateway wire endpoint. It is supplied by the PilotDeck host rather
 * than created by the SDK, so the host continues to own runtime construction,
 * storage, permissions, credentials and shutdown.
 */
export type PilotDeckEmbeddedGatewayEndpoint = {
  sendToGateway(message: string): void;
  onGatewayMessage(listener: (message: string) => void): () => void;
  onGatewayClose(listener: () => void): () => void;
  close(): void;
};

export type PilotDeckEmbeddedConnectionOptions = {
  endpoint: PilotDeckEmbeddedGatewayEndpoint;
  token: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * Controls ownership of the endpoint close. Direct embedded Query/WarmQuery
   * calls own their endpoint by default; an embedded client sets this false
   * for its per-query transports and owns the endpoint itself.
   * @internal
   */
  closeEndpoint?: boolean;
};

export type PilotDeckEmbeddedClientOptions = Omit<Partial<PilotDeckOptions>, "gatewayUrl" | "authToken" | "clientVersion" | "reconnect"> & {
  connection: Omit<PilotDeckEmbeddedConnectionOptions, "closeEndpoint">;
};

/**
 * Composition input for a complete embedded SDK surface.
 *
 * The caller must still create the authoritative Gateway and its local wire
 * endpoint. Supplying `gatewayHost` only attaches local SDK tools through the
 * existing `updateSubsystems()` boundary; it never lets the SDK construct or
 * own AgentLoop, storage, permission, model, or sandbox state.
 */
export type PilotDeckEmbeddedHostOptions = PilotDeckEmbeddedClientOptions & {
  gatewayHost?: PilotDeckEmbeddedGatewayHost;
  toolRegistry?: PilotDeckEmbeddedToolRegistry;
  /** Local TypeScript handlers to publish through the supplied Gateway host. */
  localTools?: Array<PilotDeckToolDefinition<any, unknown>>;
};

/**
 * The SDK-owned pieces of one embedded integration. `close()` detaches local
 * tool publication and closes the SDK's endpoint connection. It deliberately
 * does not dispose the caller's Gateway or alter its current native tools.
 */
export type PilotDeckEmbeddedHost = {
  client: PilotDeckClient;
  toolRegistry?: PilotDeckEmbeddedToolRegistry;
  close(): Promise<void>;
};

type EmbeddedResponseFrame = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

type EmbeddedEventFrame = {
  type: "event";
  id: string;
  seq: number;
  final: boolean;
  event: Record<string, unknown>;
};

type EmbeddedHelloFrame = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: Record<string, unknown>;
};

type EmbeddedNotificationFrame = {
  type: "notification";
  name: string;
  payload?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EmbeddedEndpointState = {
  serverInfo?: PilotDeckServerInfo;
  connecting?: Promise<PilotDeckServerInfo>;
  rejectHello?: (error: Error) => void;
  closed: boolean;
};

// A Gateway endpoint is one authenticated wire connection. Multiple SDK
// transports may use it (for example, a resource client plus a query), but
// only the first one may send the protocol hello frame.
const endpointStates = new WeakMap<PilotDeckEmbeddedGatewayEndpoint, EmbeddedEndpointState>();

function endpointState(endpoint: PilotDeckEmbeddedGatewayEndpoint): EmbeddedEndpointState {
  let state = endpointStates.get(endpoint);
  if (!state) {
    state = { closed: false };
    endpointStates.set(endpoint, state);
  }
  return state;
}

/**
 * A small in-memory implementation of the public Gateway transport contract.
 * It serializes the same frames as GatewayTransport, so an embedded host uses
 * the authoritative Gateway dispatcher instead of a parallel SDK runtime.
 */
export class PilotDeckEmbeddedTransport implements GatewayTransportClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, AsyncEventQueue<PilotDeckMessage>>();
  private readonly lastSequence = new Map<string, number>();
  private readonly notificationListeners = new Set<GatewayTransportNotificationListener>();
  private readonly detachMessage: () => void;
  private readonly detachClose: () => void;
  private readonly endpointState: EmbeddedEndpointState;
  private closed = false;
  private serverInfo?: PilotDeckServerInfo;
  private connecting?: Promise<PilotDeckServerInfo>;

  constructor(private readonly options: PilotDeckEmbeddedConnectionOptions) {
    this.endpointState = endpointState(options.endpoint);
    this.detachMessage = options.endpoint.onGatewayMessage((message) => this.handleMessage(message));
    this.detachClose = options.endpoint.onGatewayClose(() => {
      this.endpointState.closed = true;
      this.fail(new PilotDeckError({
        code: "transport_error",
        message: "Embedded Gateway endpoint closed.",
        retryable: true,
      }), true);
    });
  }

  connect(): Promise<PilotDeckServerInfo> {
    if (this.serverInfo) return Promise.resolve(this.serverInfo);
    if (this.connecting) return this.connecting;
    if (this.endpointState.serverInfo) {
      this.serverInfo = this.endpointState.serverInfo;
      return Promise.resolve(this.serverInfo);
    }
    if (this.endpointState.connecting) {
      this.connecting = this.endpointState.connecting.then((info) => {
        this.serverInfo = info;
        return info;
      });
      return this.connecting;
    }
    if (this.closed) return Promise.reject(new PilotDeckError({ code: "transport_error", message: "Embedded Gateway transport is closed." }));
    if (this.endpointState.closed) return Promise.reject(new PilotDeckError({ code: "transport_error", message: "Embedded Gateway endpoint is closed." }));
    const connecting = new Promise<PilotDeckServerInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.endpointState.rejectHello = undefined;
        reject(new PilotDeckError({ code: "timeout", message: "Embedded Gateway hello timed out.", retryable: true }));
      }, this.options.connectTimeoutMs ?? 10_000);
      this.endpointState.rejectHello = (error) => {
        clearTimeout(timer);
        this.endpointState.rejectHello = undefined;
        reject(error);
      };
      const poll = () => {
        if (this.endpointState.serverInfo) {
          clearTimeout(timer);
          this.endpointState.rejectHello = undefined;
          this.serverInfo = this.endpointState.serverInfo;
          resolve(this.serverInfo);
          return;
        }
        if (this.closed || this.endpointState.closed) {
          clearTimeout(timer);
          this.endpointState.rejectHello = undefined;
          reject(new PilotDeckError({ code: "transport_error", message: "Embedded Gateway endpoint closed during hello.", retryable: true }));
          return;
        }
        setTimeout(poll, 0);
      };
      poll();
    });
    this.connecting = connecting;
    this.endpointState.connecting = connecting;
    void connecting.then(
      () => {
        if (this.connecting === connecting) this.connecting = undefined;
        if (this.endpointState.connecting === connecting) this.endpointState.connecting = undefined;
      },
      () => {
        if (this.connecting === connecting) this.connecting = undefined;
        if (this.endpointState.connecting === connecting) this.endpointState.connecting = undefined;
      },
    );
    try {
      this.options.endpoint.sendToGateway(JSON.stringify({
        type: "hello",
        protocolVersion: "1.1",
        clientName: "sdk",
        clientVersion: this.options.clientVersion ?? "0.1.0",
        token: this.options.token,
      }));
    } catch (cause) {
      this.endpointState.rejectHello?.(mapError(cause));
    }
    return connecting;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PilotDeckError({ code: "timeout", message: `Gateway request timed out: ${method}`, requestId: id, retryable: true }));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ type: "request", id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(mapError(cause));
      }
    });
  }

  stream(method: string, params: unknown): AsyncIterable<PilotDeckMessage> {
    const id = randomUUID();
    const queue = new AsyncEventQueue<PilotDeckMessage>();
    this.streams.set(id, queue);
    this.lastSequence.set(id, -1);
    try {
      this.send({ type: "request", id, method, params });
    } catch (cause) {
      this.streams.delete(id);
      this.lastSequence.delete(id);
      queue.fail(mapError(cause));
    }
    return queue;
  }

  onNotification(listener: GatewayTransportNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachMessage();
    this.detachClose();
    const error = new PilotDeckError({ code: "transport_error", message: "Embedded Gateway transport is closed." });
    this.fail(error, this.options.closeEndpoint !== false);
    if (this.options.closeEndpoint !== false) {
      this.endpointState.closed = true;
      this.options.endpoint.close();
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed) throw new PilotDeckError({ code: "transport_error", message: "Embedded Gateway transport is closed." });
    this.options.endpoint.sendToGateway(JSON.stringify(frame));
  }

  private handleMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch (cause) {
      this.fail(new PilotDeckError({ code: "validation_error", message: "Embedded Gateway emitted invalid JSON.", cause }));
      return;
    }
    if (isEmbeddedHelloFrame(frame)) {
      const info = embeddedServerInfo(frame.serverInfo);
      this.endpointState.serverInfo ??= info;
      this.serverInfo = this.endpointState.serverInfo;
      return;
    }
    if (isEmbeddedResponseFrame(frame)) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(mapError(frame.error ?? { code: "gateway_request_failed", message: "Embedded Gateway request failed." }));
        return;
      }
      const stream = this.streams.get(frame.id);
      if (!stream) return;
      this.streams.delete(frame.id);
      this.lastSequence.delete(frame.id);
      if (frame.ok) stream.close();
      else stream.fail(mapError(frame.error ?? { code: "gateway_request_failed", message: "Embedded Gateway stream failed." }));
      return;
    }
    if (isEmbeddedNotificationFrame(frame)) {
      for (const listener of this.notificationListeners) {
        try {
          listener({ name: frame.name, ...(frame.payload === undefined ? {} : { payload: frame.payload }) });
        } catch {
          // Application listeners cannot interfere with Gateway dispatch.
        }
      }
      return;
    }
    if (!isEmbeddedEventFrame(frame)) return;
    const stream = this.streams.get(frame.id);
    if (!stream) return;
    if (!Number.isInteger(frame.seq) || frame.seq < 0) {
      this.closeStreamWithError(frame.id, new PilotDeckError({ code: "validation_error", message: `Gateway event sequence must be a non-negative integer for ${frame.id}.` }));
      return;
    }
    const previous = this.lastSequence.get(frame.id) ?? -1;
    if (frame.seq <= previous) return;
    if (frame.seq !== previous + 1) {
      this.closeStreamWithError(frame.id, new PilotDeckError({ code: "validation_error", message: `Gateway event sequence gap for ${frame.id}: expected ${previous + 1}, received ${frame.seq}.` }));
      return;
    }
    this.lastSequence.set(frame.id, frame.seq);
    stream.push({ ...frame.event, sequence: frame.seq } as PilotDeckMessage);
    if (frame.final) {
      this.streams.delete(frame.id);
      this.lastSequence.delete(frame.id);
      stream.close();
    }
  }

  private closeStreamWithError(id: string, error: Error): void {
    const stream = this.streams.get(id);
    this.streams.delete(id);
    this.lastSequence.delete(id);
    stream?.fail(error);
  }

  private fail(error: Error, rejectSharedHello = false): void {
    if (rejectSharedHello) {
      const rejectHello = this.endpointState.rejectHello;
      this.endpointState.rejectHello = undefined;
      rejectHello?.(error);
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    this.lastSequence.clear();
  }
}

function isEmbeddedHelloFrame(value: unknown): value is EmbeddedHelloFrame {
  return isEmbeddedRecord(value)
    && value.type === "hello_ok"
    && typeof value.protocolVersion === "string"
    && typeof value.serverVersion === "string"
    && isEmbeddedRecord(value.serverInfo);
}

function isEmbeddedResponseFrame(value: unknown): value is EmbeddedResponseFrame {
  return isEmbeddedRecord(value)
    && value.type === "response"
    && typeof value.id === "string"
    && typeof value.ok === "boolean";
}

function isEmbeddedEventFrame(value: unknown): value is EmbeddedEventFrame {
  return isEmbeddedRecord(value)
    && value.type === "event"
    && typeof value.id === "string"
    && typeof value.seq === "number"
    && typeof value.final === "boolean"
    && isEmbeddedRecord(value.event);
}

function isEmbeddedNotificationFrame(value: unknown): value is EmbeddedNotificationFrame {
  return isEmbeddedRecord(value)
    && value.type === "notification"
    && typeof value.name === "string";
}

function isEmbeddedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function embeddedServerInfo(value: Record<string, unknown>): PilotDeckServerInfo {
  return {
    mode: value.mode as PilotDeckServerInfo["mode"],
    protocolVersion: typeof value.protocolVersion === "string" ? value.protocolVersion : "1.1",
    serverVersion: typeof value.serverVersion === "string" ? value.serverVersion : "embedded",
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String) : [],
  };
}

/** Runs a normal SDK query through an in-process Gateway wire endpoint. */
export function createEmbeddedQuery(params: {
  prompt: string | AsyncIterable<PilotDeckUserMessage>;
  options?: PilotDeckOptions;
  connection: PilotDeckEmbeddedConnectionOptions;
}): PilotDeckQuery {
  const transport = new PilotDeckEmbeddedTransport(params.connection);
  return createQueryWithTransport(params.prompt, params.options ?? {}, transport);
}

/** Establishes an embedded Gateway connection before submitting one query. */
export async function startupEmbedded(params: {
  options?: PilotDeckOptions;
  connection: PilotDeckEmbeddedConnectionOptions;
}): Promise<PilotDeckWarmQuery> {
  const transport = new PilotDeckEmbeddedTransport(params.connection);
  return createWarmQueryWithTransport(params.options ?? {}, transport);
}

/**
 * Creates the complete typed SDK resource façade over an in-process Gateway.
 *
 * The supplied endpoint must come from the PilotDeck host's
 * `createEmbeddedGatewayEndpoint()`. This client owns only its protocol
 * connections; the host remains the sole owner of Gateway/AgentLoop/session,
 * storage, permission, model and sandbox lifecycles.
 */
export function createEmbeddedPilotDeckClient(
  options: PilotDeckEmbeddedClientOptions,
): PilotDeckClient {
  const { connection, ...defaults } = options;
  let ownsEndpoint = true;
  return createPilotDeckClientWithTransportFactory(defaults, () => {
    const closeEndpoint = ownsEndpoint;
    ownsEndpoint = false;
    // The client control connection owns the endpoint. Per-query transports
    // only detach their listeners when closed, keeping sibling calls alive.
    return new PilotDeckEmbeddedTransport({ ...connection, closeEndpoint });
  });
}

/**
 * Local-only tool registry for an embedded PilotDeck host.
 *
 * Registering a tool converts it to the same structural definition consumed
 * by `createLocalGateway({ extraTools })`. Attached hosts are refreshed after
 * every mutation; the native Gateway remains responsible for validation,
 * permission, scheduling, session scoping, and tool execution.
 */
export class PilotDeckEmbeddedToolRegistry {
  private readonly definitions = new Map<string, PilotDeckEmbeddedToolDefinition>();
  private readonly hosts = new Set<PilotDeckEmbeddedGatewayHost>();

  constructor(options: PilotDeckEmbeddedToolRegistryOptions = {}) {
    for (const tool of options.tools ?? []) this.register(tool);
  }

  register<Input, Schema>(tool: PilotDeckToolDefinition<Input, Schema>): PilotDeckEmbeddedToolDefinition<Input, Schema> {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name) {
      throw new PilotDeckError({ code: "validation_error", message: "Embedded tools require a non-empty name." });
    }
    if (this.definitions.has(name)) {
      throw new PilotDeckError({ code: "conflict", message: `Embedded tool ${name} is already registered.` });
    }
    const definition = toEmbeddedTool(tool);
    this.definitions.set(name, definition);
    this.publish();
    return definition;
  }

  unregister(name: string): boolean {
    const deleted = this.definitions.delete(name);
    if (deleted) this.publish();
    return deleted;
  }

  list(): PilotDeckEmbeddedToolDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Refresh a local Gateway whenever the registry changes. The returned
   * function detaches the host without mutating its current runtime.
   */
  attach(host: PilotDeckEmbeddedGatewayHost): () => void {
    if (!host || typeof host.updateSubsystems !== "function") {
      throw new PilotDeckError({ code: "validation_error", message: "Embedded tool registry requires a Gateway host with updateSubsystems()." });
    }
    host.updateSubsystems({ extraTools: this.list() });
    this.hosts.add(host);
    return () => this.hosts.delete(host);
  }

  private publish(): void {
    const extraTools = this.list();
    for (const host of this.hosts) host.updateSubsystems({ extraTools });
  }
}

export function createEmbeddedToolRegistry(
  options?: PilotDeckEmbeddedToolRegistryOptions,
): PilotDeckEmbeddedToolRegistry {
  return new PilotDeckEmbeddedToolRegistry(options);
}

/**
 * Composes the repetitive embedded setup without creating a second runtime:
 * a typed resource client, an optional local tool registry, and deterministic
 * registry detachment when the SDK connection closes.
 *
 * The supplied endpoint and Gateway host are both owned by the embedding
 * application. In particular, closing this object follows normal Gateway
 * disconnect behavior for active runs and never calls the host's `dispose()`.
 */
export function createEmbeddedPilotDeckHost(
  options: PilotDeckEmbeddedHostOptions,
): PilotDeckEmbeddedHost {
  const { gatewayHost, toolRegistry: suppliedRegistry, localTools, ...clientOptions } = options;
  if ((suppliedRegistry || localTools?.length) && !gatewayHost) {
    throw new PilotDeckError({
      code: "validation_error",
      message: "Embedded local tools require gatewayHost so they can be published through updateSubsystems().",
    });
  }

  const toolRegistry = suppliedRegistry ?? (localTools?.length ? createEmbeddedToolRegistry() : undefined);
  for (const tool of localTools ?? []) toolRegistry?.register(tool);

  // attach() only owns the registry subscription. It intentionally leaves
  // the host's existing native tool configuration intact after close().
  const detachTools = toolRegistry && gatewayHost ? toolRegistry.attach(gatewayHost) : undefined;
  const client = createEmbeddedPilotDeckClient(clientOptions);
  let closing: Promise<void> | undefined;

  return {
    client,
    ...(toolRegistry ? { toolRegistry } : {}),
    close: () => {
      closing ??= (async () => {
        detachTools?.();
        await client.close();
      })();
      return closing;
    },
  };
}
