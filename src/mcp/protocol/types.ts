/**
 * MCP runtime protocol (C1 §6.1 of the deferred-feature guide).
 * Mirrors the legacy contracts in `services/mcp/client.ts` (M1-M16).
 */

export type PilotDeckMcpServerSpec =
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      /**
       * When true, the MCP runtime injects a unique `--user-data-dir` per
       * spawn so multiple concurrent sessions each get their own isolated
       * browser profile on disk.  The temp directory is cleaned up when the
       * client closes.
       */
      perSession?: boolean;
    }
  | {
      id: string;
      transport: "streamable_http";
      url: string;
      headers?: Record<string, string>;
    };

export type PilotDeckMcpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
};

/**
 * Runtime view of a tool advertised by an MCP server. Already sanitized
 * (M9), wire-named (M10), and description-truncated (M11).
 */
export type PilotDeckMcpToolSpec = {
  serverId: string;
  toolName: string;
  wireName: string;
  description: string;
  inputSchema: unknown;
  annotations?: PilotDeckMcpToolAnnotations;
  meta?: Record<string, unknown>;
};

export type PilotDeckMcpStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "error"
  | "needs-auth";

export type PilotDeckMcpServerInstructions = {
  serverId: string;
  instructions: string;
};

export type PilotDeckMcpClientStatusEntry = {
  serverId: string;
  status: PilotDeckMcpStatus;
  error?: string;
};
