import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckToolAuditRecorder,
  PilotDeckFileUpdateNotifier,
  PilotDeckToolFileHistorySink,
  PilotDeckToolScheduler,
  ToolRegistry,
} from "../../tool/index.js";
import type { PlanFileManager } from "../../tool/builtin/planFile.js";
import type { PlanTodoStateManager } from "./PlanTodoState.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { RouterRuntime } from "../../router/index.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";

/**
 * Narrow view of the router that the agent loop actually consumes. Tests can
 * inject anything that satisfies this contract; production wiring uses
 * `createRouterRuntime`.
 *
 * `decide` + `execute` are exposed so the agent loop can insert a post-routing
 * compaction pass between the routing decision and the model call.
 */
export type AgentRouterRuntime = Pick<RouterRuntime, "stream" | "decide" | "execute"> & {
  materializeRequest?: RouterRuntime["materializeRequest"];
  observeUsage?: RouterRuntime["observeUsage"];
  invalidateSticky?: RouterRuntime["invalidateSticky"];
};

/**
 * Subagent sidechain transcript hooks (C3 §6.3). The agent loop calls these
 * around a forked subagent so:
 *   - `recordSubagentStarted` writes a `subagent_started` reference into the
 *     **parent** transcript (truncated directive preview).
 *   - `recordSubagentCompleted` writes a `subagent_completed` reference into
 *     the **parent** transcript (truncated summary + usage / duration).
 *   - `subagentTranscriptResolver(subagentId)` returns a sidechain writer
 *     that captures the subagent's turn-by-turn entries into a separate
 *     `<subagentId>.jsonl` file.
 *
 * All hooks are optional — when missing, the agent loop falls back to the
 * legacy "no sidechain" behavior (subagent runs, but no persistence).
 */
export type AgentSubagentTranscriptHooks = {
  recordSubagentStarted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    prompt: string;
    transcriptRelativePath: string;
    subagentSessionId?: string;
  }): Promise<void>;
  recordSubagentCompleted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    summary: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    };
    turns: number;
    durationMs: number;
    errored?: boolean;
  }): Promise<void>;
  subagentTranscriptResolver?(subagentId: string): {
    recordAcceptedInput(
      sessionId: string,
      turnId: string,
      messages: CanonicalMessage[],
      metadata?: Record<string, unknown>,
    ): Promise<void>;
    recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void>;
    transcriptRelativePath: string;
  };
};

export type AgentRuntimeDependencies = {
  router: AgentRouterRuntime;
  tools: {
    scheduler: PilotDeckToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  tokenAccounting?: TokenAccountingRuntime;
  /**
   * Look up a model's context-window size by provider/model id. Used after
   * routing to re-evaluate compaction against the target model's window when
   * it is smaller than the agent's default model. Returns `undefined` for
   * unknown models so the caller can skip re-compaction gracefully.
   */
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  /**
   * Look up a model's maximum output-token cap by provider/model id. Used by
   * max-output recovery to avoid retrying with a lower synthetic default than
   * the selected model already receives from the catalog.
   */
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
  getModelTokenLimits?: (provider: string, model: string) => { maxContextTokens: number; maxOutputTokens: number } | undefined;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: PilotDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  /** C3 sidechain transcript hooks (optional). */
  subagentTranscript?: AgentSubagentTranscriptHooks;
  /**
   * Elicitation channel — wired into the per-tool `PilotDeckToolRuntimeContext`
   * so `ask_user_question` (B1) can drive the gateway. When omitted, the
   * tool returns a `mcp_unavailable` error instead of crashing.
   */
  elicitation?: PilotDeckElicitationChannel;
  /**
   * File-history sink — wired into the per-tool runtime context so
   * `edit_file` / `write_file` (C4) snapshot the file before mutation.
   * `FileHistoryStore` directly satisfies this contract.
   */
  fileHistory?: PilotDeckToolFileHistorySink;
  /**
   * Optional sink for propagating successful file writes to editor / LSP
   * integrations. When absent, write_file still succeeds and performs no
   * post-write host notifications.
   */
  fileUpdateNotifier?: PilotDeckFileUpdateNotifier;
  /**
   * Plan file manager — resolves the project-local `.pilotdeck/plans`
   * directory and reads explicitly submitted plan documents for
   * `enter_plan_mode` / `exit_plan_mode`. Absent in headless / test runtimes.
   */
  planFileManager?: PlanFileManager;
  /** Session-scoped state tracking required `todo_write` calls after plan approval. */
  planTodoManager?: PlanTodoStateManager;
  eventEmitter?: AgentEventEmitter;
  drainEvents?: () => AgentEvent[];
};

export type AgentLegacyModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};
