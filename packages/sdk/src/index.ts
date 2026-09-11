export * from "./types.js";
export * from "./transport.js";
export * from "./session-store.js";
export * from "./compat.js";
export * from "./embedded.js";
export * from "./terminal-dialog.js";
export * from "./browser-dialog.js";
export * from "./browser-dom-dialog.js";
export * from "./manual-dialog-renderer.js";
export {
  createQuery,
  createWarmQuery,
  createPilotDeckClient,
  listSessions,
  getSessionMessages,
  getSessionInfo,
  exportSessionTranscript,
  restoreSessionTranscript,
  prepareLastTurnReplacement,
  renameSession,
  tagSession,
  forkSession,
  resolveSettings,
  defineTool,
  createPilotDeckMcpServer,
  createSdkMcpServer,
  toEmbeddedTool,
  deleteSession,
  getSubagentMessages,
  listSubagents,
} from "./client.js";

import { createQuery } from "./client.js";
import type { PilotDeckOptions, PilotDeckQuery, PilotDeckUserMessage } from "./types.js";

/** Claude Agent SDK-like façade. */
export function query(params: { prompt: string | AsyncIterable<PilotDeckUserMessage>; options?: PilotDeckOptions }): PilotDeckQuery {
  return createQuery(params.prompt, params.options ?? {});
}

export { defineTool as tool } from "./client.js";

import { createWarmQuery } from "./client.js";

export async function startup(params?: { options?: PilotDeckOptions; initializeTimeoutMs?: number }) {
  const options = { ...(params?.options ?? {}) };
  if (params?.initializeTimeoutMs !== undefined) options.timeoutMs = params.initializeTimeoutMs;
  return createWarmQuery(options);
}
