/**
 * `McpRuntime` — top-level orchestrator for many `McpClient`s. Implements
 * M4 (bounded connect concurrency) and exposes the data shape consumed by
 * the `PluginToToolBridge` (`listAllTools`) and the prompt assembler
 * (`getInstructions`).
 *
 * The runtime is process-local (one per agent session). Cross-process
 * sharing is not in scope for this PR.
 */

import { McpClient, McpClientError, type McpClientOptions } from "../client/McpClient.js";
import { awaitWithAbort } from "../../runtime/abort.js";
import type {
  PilotDeckMcpClientStatusEntry,
  PilotDeckMcpServerInstructions,
  PilotDeckMcpServerSpec,
  PilotDeckMcpToolSpec,
} from "../protocol/types.js";

export type McpRuntimeOptions = {
  /** Max parallel `connect()` calls during `start()`. M4. Default 5. */
  connectConcurrency?: number;
  /** Per-client options passed through to `McpClient`. */
  clientOptions?: McpClientOptions;
};

export class McpRuntime {
  private readonly clients = new Map<string, McpClient>();
  private readonly catalogs = new Map<string, PilotDeckMcpToolSpec[]>();
  private refreshInFlight?: Promise<PilotDeckMcpToolSpec[]>;
  private stopVersion = 0;
  private stopped = false;
  private stopInFlight?: Promise<void>;
  private readonly options: Required<Pick<McpRuntimeOptions, "connectConcurrency">> &
    Pick<McpRuntimeOptions, "clientOptions">;

  constructor(
    public readonly servers: PilotDeckMcpServerSpec[],
    options: McpRuntimeOptions = {},
  ) {
    this.options = {
      connectConcurrency: options.connectConcurrency ?? 5,
      clientOptions: options.clientOptions,
    };
    for (const spec of servers) {
      this.clients.set(spec.id, new McpClient(spec, this.options.clientOptions));
    }
  }

  /** Start each client. Errors are captured per server (do not abort the rest). */
  async start(): Promise<PilotDeckMcpClientStatusEntry[]> {
    this.stopped = false;
    const stopVersion = this.stopVersion;
    const queue = [...this.clients.values()];
    const concurrency = Math.max(1, Math.min(this.options.connectConcurrency, queue.length));
    const results: PilotDeckMcpClientStatusEntry[] = [];

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            if (stopVersion !== this.stopVersion) break;
            const client = queue.shift();
            if (!client) break;
            try {
              await client.start();
              results.push({ serverId: client.spec.id, status: client.getStatus() });
            } catch (err) {
              results.push({
                serverId: client.spec.id,
                status: "error",
                // `err` may not be an `Error` instance (throw strings, plain
                // objects, `null`, etc.). Coerce defensively so the status
                // entry always carries a human-readable message — otherwise
                // `error` is `undefined` and downstream UI silently shows
                // "unknown error".
                error: err instanceof McpClientError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : String(err),
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.stopInFlight;
    this.stopped = true;
    this.stopVersion++;
    this.refreshInFlight = undefined;
    const pending = Promise.all([...this.clients.values()].map(c => c.close())).then(() => {});
    this.stopInFlight = pending;
    try { await pending; }
    finally { if (this.stopInFlight === pending) this.stopInFlight = undefined; }
  }

  /** Refresh ready or previously discovered servers, retaining failed servers' last complete catalog. */
  async refreshToolCatalog(signal?: AbortSignal): Promise<PilotDeckMcpToolSpec[]> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("MCP runtime is stopped");
    if (!this.refreshInFlight) {
      const pending = this.refreshCatalog();
      this.refreshInFlight = pending;
      void pending.finally(() => { if (this.refreshInFlight === pending) this.refreshInFlight = undefined; }).catch(() => {});
    }
    return structuredClone(await awaitWithAbort(signal, () => this.refreshInFlight!));
  }

  private async refreshCatalog(): Promise<PilotDeckMcpToolSpec[]> {
    const stopVersion = this.stopVersion;
    const next = new Map(this.catalogs);
    const queue = [...this.clients.values()].filter(client => client.getStatus() === "ready" || next.has(client.spec.id));
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.options.connectConcurrency, queue.length)) }, async () => {
      while (queue.length) {
        if (stopVersion !== this.stopVersion) return;
        const client = queue.shift()!;
        try { next.set(client.spec.id, await client.listTools()); }
        catch { /* Keep the last complete contract until this server recovers. */ }
      }
    }));
    if (stopVersion !== this.stopVersion) throw new Error("MCP runtime stopped during catalog refresh");
    this.catalogs.clear();
    for (const [id, tools] of next) this.catalogs.set(id, tools);
    return [...next.values()].flat();
  }

  /** Aggregate every advertised tool across every client. */
  async listAllTools(): Promise<PilotDeckMcpToolSpec[]> {
    const out: PilotDeckMcpToolSpec[] = [];
    for (const client of this.clients.values()) {
      if (client.getStatus() !== "ready") continue;
      try {
        const tools = await client.listTools();
        this.catalogs.set(client.spec.id, tools);
        out.push(...tools);
      } catch {
        // skip — `start()` already recorded the error
      }
    }
    return out;
  }

  /** Runtime-fetched server instructions (B3 upgrade path). */
  getInstructions(): PilotDeckMcpServerInstructions[] {
    const out: PilotDeckMcpServerInstructions[] = [];
    for (const client of this.clients.values()) {
      if (client.getStatus() !== "ready") continue;
      const instructions = client.getInstructions();
      if (instructions.trim().length === 0) continue;
      out.push({ serverId: client.spec.id, instructions });
    }
    out.sort((a, b) => a.serverId.localeCompare(b.serverId));
    return out;
  }

  statuses(): PilotDeckMcpClientStatusEntry[] {
    return [...this.clients.values()].map((c) => ({
      serverId: c.spec.id,
      status: c.getStatus(),
    }));
  }
}
