import type { CanonicalThinkingConfig, CanonicalToolChoice, MultimodalConstraints } from "../../model/index.js";
import type { PermissionContext, PermissionMode } from "../../permission/index.js";

export type AgentRuntimeConfig = {
  provider: string;
  model: string;
  /** Multimodal constraints of the selected model (absent = text-only). */
  modelMultimodal?: MultimodalConstraints;
  cwd: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: CanonicalThinkingConfig;
  toolChoice?: CanonicalToolChoice;
  maxContextMessages?: number;
  stopOnStructuredOutput?: boolean;
  permissionMode: PermissionMode;
  /** Who last set the current mode: "user" (UI/CLI) or "tool" (enter_plan_mode). */
  permissionModeOrigin?: "user" | "tool";
  /** Saved mode before entering plan mode, restored on exit. */
  permissionModeBeforePlan?: PermissionMode;
  permissionContext: PermissionContext;
  env?: NodeJS.ProcessEnv;
  maxResultBytes?: number;
  metadata?: Record<string, unknown>;
  /** Marks the agent as a subagent. RouterRuntime uses this for sticky/scenario decisions. */
  isSubagent?: boolean;
  /**
   * Subagent fork depth — incremented on each level of `agent` tool fork.
   * Top-level agent runs at depth 0; `agent` tool refuses to spawn another
   * subagent once `subagentDepth >= maxSubagentDepth`. Default 0.
   */
  subagentDepth?: number;
  /**
   * Cap on `subagentDepth`. Defaults to 1 (one level of forking allowed,
   * but no nested forks). Increase only when intentional.
   */
  maxSubagentDepth?: number;
  /** Optional timeout budget for forked subagents spawned by the `agent` tool. */
  subagentTimeoutMs?: number;
  /** Enable automatic JSON self-correction retry on invalid_tool_arguments. Default false. */
  jsonSelfCorrect?: boolean;
  /**
   * The agent's default-model context window (tokens). Passed through so the
   * loop can compare it with the routed model's window and trigger a
   * post-routing compaction pass when the routed window is smaller.
   */
  maxContextTokens?: number;
};
