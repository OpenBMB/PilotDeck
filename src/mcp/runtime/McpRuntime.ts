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
    const queue = [...this.clients.values()];
    const concurrency = Math.max(1, Math.min(this.options.connectConcurrency, queue.length));
    const results: PilotDeckMcpClientStatusEntry[] = [];

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const client = queue.shift();
            if (!client) break;
            try {
              await client.start();
              results.push({ serverId: client.spec.id, status: client.getStatus() });
            } catch (err) {
              results.push({
                serverId: client.spec.id,
                status: "error",
                error: err instanceof McpClientError ? err.message : (err as Error).message,
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
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }

  /** Aggregate every advertised tool across every client. */
  async listAllTools(): Promise<PilotDeckMcpToolSpec[]> {
    const out: PilotDeckMcpToolSpec[] = [];
    for (const client of this.clients.values()) {
      if (client.getStatus() !== "ready") continue;
      try {
        const tools = await client.listTools();
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
