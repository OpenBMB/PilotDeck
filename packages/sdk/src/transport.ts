import { randomUUID } from "node:crypto";
import { PilotDeckError, type PilotDeckMessage, type PilotDeckServerInfo } from "./types.js";

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(name: string, handler: (event: any) => void): void;
};

type WireEventFrame = { type: "event"; id: string; seq: number; final: boolean; event: Record<string, unknown> };
type WireResponse = { type: "response"; id: string; ok: true; result: unknown } | { type: "response"; id: string; ok: false; error: { code?: string; message?: string; details?: unknown } };
type WireHelloOk = { type: "hello_ok"; protocolVersion: string; serverVersion: string; serverInfo: Record<string, unknown> };

export type GatewayConnectionOptions = {
  url: string;
  token: string;
  clientName?: "cli" | "tui" | "web" | "feishu" | "sdk" | "test";
  clientVersion?: string;
  protocolVersion?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional retry policy for transient connection/handshake failures. */
  reconnect?: GatewayReconnectOptions;
};

export type GatewayReconnectOptions = {
  /** Total connection attempts, including the first attempt. Defaults to 1. */
  maxAttempts?: number;
  /** Initial delay between attempts in milliseconds. */
  initialDelayMs?: number;
  /** Upper bound for exponential backoff delay. */
  maxDelayMs?: number;
  /** Randomized delay fraction in [0, 1]. Defaults to 0.2. */
  jitter?: number;
};

/**
 * Shared SDK transport surface. The default implementation is WebSocket;
 * embedded hosts can provide an in-process transport that preserves the same
 * Gateway wire contract without exposing runtime internals to the SDK.
 */
export type GatewayTransportClient = {
  connect(): Promise<PilotDeckServerInfo>;
  request(method: string, params: unknown): Promise<unknown>;
  stream(method: string, params: unknown): AsyncIterable<PilotDeckMessage>;
  /** Server-pushed infrastructure or resource change hint. */
  onNotification?(listener: GatewayTransportNotificationListener): () => void;
  close(): void;
};

export type GatewayTransportNotification = { name: string; payload?: unknown };
export type GatewayTransportNotificationListener = (notification: GatewayTransportNotification) => void;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class GatewayTransport {
  private socket?: SocketLike;
  private hello?: WireHelloOk;
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, AsyncEventQueue<PilotDeckMessage>>();
  private readonly lastSeq = new Map<string, number>();
  private readonly notificationListeners = new Set<GatewayTransportNotificationListener>();
  private closed = false;
  private connecting?: Promise<PilotDeckServerInfo>;
  private helloReject?: (error: Error) => void;

  constructor(private readonly options: GatewayConnectionOptions) {}

  connect(): Promise<PilotDeckServerInfo> {
    if (this.hello && this.socket?.readyState === 1) {
      return Promise.resolve(this.serverInfo(this.hello));
    }
    if (this.connecting) return this.connecting;
    const connecting = this.openWithRetry();
    this.connecting = connecting;
    void connecting.then(
      () => { if (this.connecting === connecting) this.connecting = undefined; },
      () => { if (this.connecting === connecting) this.connecting = undefined; },
    );
    return connecting;
  }

  private async openWithRetry(): Promise<PilotDeckServerInfo> {
    const policy = this.options.reconnect;
    const maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? 1));
    const initialDelayMs = Math.max(0, policy?.initialDelayMs ?? 100);
    const maxDelayMs = Math.max(initialDelayMs, policy?.maxDelayMs ?? 2_000);
    const jitter = Math.min(1, Math.max(0, policy?.jitter ?? 0.2));
    let attempt = 0;
    while (true) {
      if (this.closed) throw new PilotDeckError({ code: "transport_error", message: "Gateway client closed.", retryable: false });
      attempt += 1;
      try {
        return await this.open();
      } catch (error) {
        const mapped = mapError(error);
        if (attempt >= maxAttempts || !isRetryableConnectError(mapped) || this.closed) throw mapped;
        const failedSocket = this.socket;
        this.socket = undefined;
        failedSocket?.close();
        const base = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)));
        const factor = jitter === 0 ? 1 : 1 + ((Math.random() * 2 - 1) * jitter);
        await delay(Math.max(0, Math.round(base * factor)));
      }
    }
  }

  private async open(): Promise<PilotDeckServerInfo> {
    const Socket = (globalThis as any).WebSocket;
    if (!Socket) throw new PilotDeckError({ code: "transport_error", message: "WebSocket is unavailable in this runtime." });
    this.hello = undefined;
    const socket = new Socket(this.options.url) as SocketLike;
    this.closed = false;
    this.socket = socket;
    socket.addEventListener("message", (event: any) => {
      if (this.socket === socket) this.handleMessage(String(event.data ?? ""));
    });
    socket.addEventListener("close", (event: any) => {
      if (this.socket !== socket) return;
      const code = Number(event?.code ?? 0);
      const reason = String(event?.reason ?? "");
      const errorCode = code === 4003 || reason === "auth_failed"
        ? "authentication_error"
        : reason === "protocol_mismatch"
          ? "protocol_version_error"
          : "transport_error";
      this.failPending(new PilotDeckError({ code: errorCode, message: reason || "Gateway WebSocket closed.", retryable: errorCode === "transport_error" }));
    });
    await this.waitForOpen(socket);
    socket.send(JSON.stringify({ type: "hello", protocolVersion: this.options.protocolVersion ?? "1.1", clientName: this.options.clientName ?? "sdk", clientVersion: this.options.clientVersion ?? "0.1.0", token: this.options.token }));
    const hello = await new Promise<WireHelloOk>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloReject = undefined;
        reject(new PilotDeckError({ code: "timeout", message: "Gateway hello timed out.", retryable: true }));
      }, this.options.connectTimeoutMs ?? 10_000);
      this.helloReject = (error) => {
        clearTimeout(timer);
        this.helloReject = undefined;
        reject(error);
      };
      const poll = () => {
        if (this.hello) {
          clearTimeout(timer);
          this.helloReject = undefined;
          resolve(this.hello);
          return;
        }
        if (!this.socket) {
          clearTimeout(timer);
          this.helloReject = undefined;
          reject(new PilotDeckError({ code: "transport_error", message: "Gateway disconnected during hello.", retryable: true }));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    return this.serverInfo(hello);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new PilotDeckError({ code: "timeout", message: `Gateway request timed out: ${method}`, requestId: id, retryable: true })); }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: "request", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  stream(method: string, params: unknown): AsyncIterable<PilotDeckMessage> {
    const id = randomUUID();
    const queue = new AsyncEventQueue<PilotDeckMessage>();
    this.streams.set(id, queue);
    this.lastSeq.set(id, -1);
    try { this.send({ type: "request", id, method, params }); }
    catch (error) { this.streams.delete(id); this.lastSeq.delete(id); queue.fail(error instanceof Error ? error : new Error(String(error))); }
    return queue;
  }

  onNotification(listener: GatewayTransportNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.failPending(new PilotDeckError({ code: "transport_error", message: "Gateway client closed." }));
    socket?.close();
  }

  private serverInfo(hello: WireHelloOk): PilotDeckServerInfo {
    const info = hello.serverInfo;
    return {
      mode: (info.mode as PilotDeckServerInfo["mode"]) ?? "remote",
      protocolVersion: hello.protocolVersion,
      serverVersion: hello.serverVersion,
      projectKey: info.projectKey as string | undefined,
      capabilities: info.capabilities as string[] | undefined,
    };
  }

  private async waitForOpen(socket: SocketLike): Promise<void> {
    if (socket.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PilotDeckError({ code: "timeout", message: "Gateway connection timed out.", retryable: true })), this.options.connectTimeoutMs ?? 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new PilotDeckError({ code: "transport_error", message: "Gateway connection failed.", retryable: true })); });
    });
  }

  private send(frame: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) throw new PilotDeckError({ code: "transport_error", message: "Gateway WebSocket is not connected.", retryable: true });
    this.socket.send(JSON.stringify(frame));
  }

  private handleMessage(raw: string): void {
    let frame: WireHelloOk | WireResponse | WireEventFrame | { type: "notification"; name: string; payload?: unknown };
    try { frame = JSON.parse(raw); } catch (cause) { this.failPending(new PilotDeckError({ code: "validation_error", message: "Invalid Gateway JSON frame.", cause })); return; }
    if (frame.type === "hello_ok") { this.hello = frame; return; }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        const stream = this.streams.get(frame.id);
        if (!stream) return;
        this.streams.delete(frame.id);
        this.lastSeq.delete(frame.id);
        if (frame.ok) stream.close();
        else stream.fail(new PilotDeckError({ code: normalizeGatewayCode(frame.error.code), message: frame.error.message ?? "Gateway stream failed.", details: frame.error.details }));
        return;
      }
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new PilotDeckError({ code: normalizeGatewayCode(frame.error.code), message: frame.error.message ?? "Gateway request failed.", details: frame.error.details }));
      return;
    }
    if (frame.type === "event") {
      const stream = this.streams.get(frame.id); if (!stream) return;
      if (!Number.isInteger(frame.seq) || frame.seq < 0) {
        this.streams.delete(frame.id); this.lastSeq.delete(frame.id);
        stream.fail(new PilotDeckError({ code: "validation_error", message: `Gateway event sequence must be a non-negative integer for ${frame.id}.` }));
        return;
      }
      const previous = this.lastSeq.get(frame.id) ?? -1;
      if (frame.seq <= previous) return;
      if (frame.seq !== previous + 1) {
        this.streams.delete(frame.id); this.lastSeq.delete(frame.id);
        stream.fail(new PilotDeckError({ code: "validation_error", message: `Gateway event sequence gap for ${frame.id}: expected ${previous + 1}, received ${frame.seq}.` }));
        return;
      }
      this.lastSeq.set(frame.id, frame.seq);
      stream.push({ ...frame.event, sequence: frame.seq } as PilotDeckMessage);
      if (frame.final) { this.streams.delete(frame.id); this.lastSeq.delete(frame.id); stream.close(); }
      return;
    }
    if (frame.type === "notification") {
      for (const listener of this.notificationListeners) {
        try {
          listener({ name: frame.name, ...(frame.payload === undefined ? {} : { payload: frame.payload }) });
        } catch {
          // Application listeners must not break transport semantics.
        }
      }
    }
  }

  private failPending(error: Error): void {
    const helloReject = this.helloReject;
    this.helloReject = undefined;
    helloReject?.(error);
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    this.lastSeq.clear();
    this.socket = undefined;
  }
}

export function mapError(error: unknown): PilotDeckError {
  if (error instanceof PilotDeckError) return error;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown } | undefined;
  const code = normalizeGatewayCode(typeof candidate?.code === "string" ? candidate.code : "transport_error");
  return new PilotDeckError({
    code,
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
    details: candidate?.details,
    cause: candidate?.cause ?? error,
    retryable: code === "timeout" || code === "transport_error",
  });
}

function normalizeGatewayCode(code?: string): string {
  const normalized = code?.toLowerCase();
  if (!normalized) return "gateway_request_failed";
  if (normalized === "capability_unavailable") return "unsupported_capability";
  if (normalized === "session_not_found" || normalized === "project_not_found") return "not_found";
  if (normalized === "session_busy") return "conflict";
  if (normalized === "invalid_permission_mode" || normalized.startsWith("invalid_")) return "validation_error";
  return normalized;
}

function isRetryableConnectError(error: PilotDeckError): boolean {
  return error.code === "transport_error" || error.code === "timeout";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private error?: Error;
  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else this.values.push(value); }
  close(): void { this.closed = true; while (this.waiters.length) this.waiters.shift()!.resolve({ done: true, value: undefined as never }); }
  fail(error: Error): void { this.error = error; this.closed = true; while (this.waiters.length) this.waiters.shift()!.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => { if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! }); if (this.error) return Promise.reject(this.error); if (this.closed) return Promise.resolve({ done: true, value: undefined as never }); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); } }; }
}
