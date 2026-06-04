/**
 * Browser-friendly Gateway WebSocket client.
 *
 * Mirrors the protocol behavior of `src/gateway/client/GatewayWsClient.ts`
 * but uses only browser-safe globals (`WebSocket`, `crypto.randomUUID`,
 * `fetch`). Node 22+ exposes the same globals so this module is also used
 * by the parity / contract tests under `tests/web-ui-client/`.
 */

import {
  PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB,
  type WebGatewayEvent,
  type WebGatewayFrame,
  type WebGatewayMethod,
  type WebHelloOk,
  type WebSubmitTurnInput,
} from "./protocol.js";

export type GatewayBrowserClientOptions = {
  url: string;
  token: string;
  clientName?: "web" | "test";
  clientVersion?: string;
  protocolVersion?: string;
  /** Override for tests — defaults to global `WebSocket`. */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Override for tests — defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** How long to wait for `hello_ok` before failing. */
  helloTimeoutMs?: number;
};

/**
 * Subset of WebSocket we use. Allows test doubles in node without `ws`
 * package.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
    options?: { once?: boolean },
  ): void;
}

export type GatewayBrowserStream = AsyncIterable<WebGatewayEvent>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const DEFAULT_HELLO_TIMEOUT_MS = 5000;

export class GatewayBrowserClient {
  private ws?: WebSocketLike;
  private hello?: WebHelloOk;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, AsyncEventQueue<WebGatewayEvent>>();
  private connectError?: Error;
  private closed = false;

  constructor(private readonly options: GatewayBrowserClientOptions) {}

  /** True after `hello_ok` has been received. */
  get connected(): boolean {
    return this.hello !== undefined && !this.closed;
  }

  get serverInfo(): WebHelloOk["serverInfo"] | undefined {
    return this.hello?.serverInfo;
  }

  async connect(): Promise<WebHelloOk> {
    if (this.closed) {
      throw new Error("GatewayBrowserClient was closed.");
    }
    if (this.hello) {
      return this.hello;
    }
    const ws = this.openSocket();
    this.ws = ws;

    await waitForOpen(ws);

    ws.addEventListener("message", (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : String(event.data ?? ""));
    });
    ws.addEventListener("close", (event) => {
      this.handleClose(event.code, event.reason);
    });
    ws.addEventListener("error", () => {
      this.connectError ??= new Error("Gateway WebSocket error.");
    });

    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion:
          this.options.protocolVersion ?? PILOTDECK_GATEWAY_PROTOCOL_VERSION_WEB,
        clientName: this.options.clientName ?? "web",
        clientVersion: this.options.clientVersion ?? "0.1.0",
        token: this.options.token,
      }),
    );

    const timeoutMs = this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    return await this.waitForHello(timeoutMs);
  }

  request<T = unknown>(method: WebGatewayMethod, params: unknown): Promise<T> {
    this.ensureConnected();
    const id = this.newId();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.send({ type: "request", id, method, params });
    });
  }

  stream(method: WebGatewayMethod, params: unknown): GatewayBrowserStream {
    this.ensureConnected();
    const id = this.newId();
    const queue = new AsyncEventQueue<WebGatewayEvent>();
    this.streams.set(id, queue);
    this.send({ type: "request", id, method, params });
    return queue;
  }

  submitTurn(input: WebSubmitTurnInput): GatewayBrowserStream {
    return this.stream("submit_turn", input);
  }

  /** Convenience helpers. */
  abortTurn(input: { sessionKey: string; runId?: string }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("abort_turn", input);
  }

  listSessions(input: { projectKey?: string; limit?: number; cursor?: string }) {
    return this.request<import("./protocol.js").WebListSessionsResult>(
      "list_sessions",
      input,
    );
  }

  newSession(input: {
    projectKey?: string;
    channelKey: import("./protocol.js").WebGatewayChannelKey;
    hint?: string;
  }) {
    return this.request<{ sessionKey: string }>("new_session", input);
  }

  resumeSession(input: { sessionKey: string }) {
    return this.request<{ sessionKey: string }>("resume_session", input);
  }

  closeSession(input: { sessionKey: string; reason?: string }) {
    return this.request<{ ok: boolean }>("close_session", input);
  }

  describeServer() {
    return this.request<import("./protocol.js").WebHelloOk["serverInfo"]>(
      "describe_server",
      {},
    );
  }

  getActiveTurnSnapshot(input: import("./protocol.js").WebActiveTurnSnapshotInput) {
    return this.request<import("./protocol.js").WebActiveTurnSnapshot>(
      "active_turn_snapshot",
      input,
    );
  }

  permissionDecide(input: import("./protocol.js").WebPermissionDecision) {
    return this.request<{ delivered: boolean }>("permission_decide", input);
  }

  grantSessionPermission(input: import("./protocol.js").WebSessionPermissionGrant) {
    return this.request<{ granted: boolean; entry?: string }>("grant_session_permission", input);
  }

  elicitationRespond(input: {
    sessionKey: string;
    requestId: string;
    answer: import("./protocol.js").WebElicitationAnswer;
  }) {
    return this.request<{ delivered: boolean }>("elicitation_respond", input);
  }

  readSessionMessages(
    input: import("./protocol.js").WebReadSessionMessagesInput,
  ) {
    return this.request<import("./protocol.js").WebReadSessionMessagesResult>(
      "read_session_messages",
      input,
    );
  }

  listProjects(): Promise<import("./protocol.js").WebListProjectsResult> {
    return this.request<import("./protocol.js").WebListProjectsResult>("list_projects", {});
  }

  describeProject(input: { projectKey: string }) {
    return this.request<import("./protocol.js").WebProjectSummary>("describe_project", input);
  }

  cronCreate(input: unknown) {
    return this.request<unknown>("cron_create", input);
  }
  cronList(input: unknown) {
    return this.request<unknown>("cron_list", input);
  }
  cronDelete(input: unknown) {
    return this.request<unknown>("cron_delete", input);
  }
  cronStop(input: unknown) {
    return this.request<unknown>("cron_stop", input);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ws?.close();
    this.failPendingAndStreams(new Error("Gateway client closed."));
  }

  // ---- internals ----------------------------------------------------------

  private openSocket(): WebSocketLike {
    if (this.options.webSocketFactory) {
      return this.options.webSocketFactory(this.options.url);
    }
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket is not available in this environment.");
    }
    return new WebSocket(this.options.url) as unknown as WebSocketLike;
  }

  private send(frame: unknown): void {
    if (!this.ws || this.closed) {
      throw new Error("Gateway WebSocket is not connected.");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private async waitForHello(timeoutMs: number): Promise<WebHelloOk> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.hello) {
        return this.hello;
      }
      if (this.connectError || this.closed) {
        throw this.connectError ?? new Error("Gateway WebSocket closed before hello.");
      }
      await sleep(10);
    }
    throw new Error("Gateway hello timed out.");
  }

  private ensureConnected(): void {
    if (!this.hello) {
      throw new Error("GatewayBrowserClient: call connect() before requests.");
    }
    if (this.closed) {
      throw new Error("GatewayBrowserClient: client is closed.");
    }
  }

  private handleMessage(raw: string): void {
    let frame: WebGatewayFrame;
    try {
      frame = JSON.parse(raw) as WebGatewayFrame;
    } catch {
      return;
    }
    if ((frame as WebHelloOk).type === "hello_ok") {
      this.hello = frame as WebHelloOk;
      return;
    }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(
          Object.assign(new Error(frame.error.message), { code: frame.error.code }),
        );
      }
      return;
    }
    if (frame.type === "event") {
      const stream = this.streams.get(frame.id);
      if (!stream) return;
      if (!frame.final) {
        stream.push(frame.event);
        return;
      }
      // `final: true` is a synthetic stream-end marker emitted by
      // `GatewayWsConnection`. The real `turn_completed` (if any) was
      // already pushed by the agent stream above. Dropping the synthetic
      // payload prevents double-rendering — see
      // docs/old-ui-adaptation/01-old-ui-current-state/03-data-protocols-and-state.md
      // §175.
      this.streams.delete(frame.id);
      stream.close();
    }
  }

  private handleClose(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error(
      `Gateway WebSocket closed (code=${code ?? "?"}${reason ? `, reason=${reason}` : ""}).`,
    );
    if (!this.hello) {
      this.connectError ??= error;
    }
    this.failPendingAndStreams(error);
  }

  private failPendingAndStreams(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.fail(error);
    }
    this.streams.clear();
  }

  private newId(): string {
    if (this.options.newId) {
      return this.options.newId();
    }
    const c =
      typeof globalThis !== "undefined" &&
      (globalThis as unknown as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
    // Fallback: use crypto.getRandomValues for unpredictable IDs (issue #136).
    // Math.random() was previously used here, producing predictable tokens
    // that could be exploited in WebSocket reconnection scenarios.
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `web-${Date.now().toString(36)}-${hex}`;
    }
    // Last resort (no crypto at all — extremely rare in modern runtimes)
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export async function readLocalGatewayToken(
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url),
  url = "/auth/local-token",
): Promise<string> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to read local token (HTTP ${response.status}).`);
  }
  const body = (await response.json()) as { token?: string };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Local token endpoint returned an invalid body.");
  }
  return body.token;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private error?: Error;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    this.error = error;
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.error) {
      // Do NOT clear the error — subsequent consumers must also see it.
      // Previously `this.error = undefined` here caused the error to be consumed
      // only once, after which callers got {done: true} instead of the error.
      // This broke retry logic and reconnection in WebSocket-based streams
      // (issue #128).
      return Promise.reject(this.error);
    }
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function waitForOpen(ws: WebSocketLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to open Gateway WebSocket."));
    };
    function cleanup(): void {
      // Some implementations of WebSocket may not support removeEventListener
      // — we set listeners with `once` semantics to avoid leaks.
    }
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
