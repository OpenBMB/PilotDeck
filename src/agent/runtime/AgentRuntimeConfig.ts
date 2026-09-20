import type { CanonicalThinkingConfig, CanonicalToolChoice, MultimodalConstraints } from "../../model/index.js";
import type { RuntimeContextSurface } from "../../context/RuntimeContextSurface.js";
import type { PermissionContext, PermissionMode } from "../../permission/index.js";
import type { AgentRunMode } from "../protocol/input.js";
import type { SubagentDefinition } from "../sub/builtinSubagentTypes.js";
import type { SopRuntimeConfig } from "../../sop/staffdeck/types.js";
import type { CoreModuleBinding } from "../../composition/types.js";
import type { RuntimeModuleBindings } from "../../composition/runtimePorts.js";

export type AgentRuntimeConfig = {
  provider: string;
  model: string;
  /** Gateway-resolved session fallback candidates for pre-content model failures. */
  fallbackModels?: Array<{ provider: string; model: string }>;
  /**
   * Gateway-resolved, SDK-only model restriction for this runtime. It is
   * consumed by the Router adapter per execution; absent preserves native
   * Router selection and fallback behavior.
   */
  managedModelPolicy?: { allow: string[]; deny: string[] };
  /** Opt-in projection of transient tool progress to the Gateway event stream. */
  includeToolProgress?: boolean;
  /** Multimodal constraints of the selected model (absent = text-only). */
  modelMultimodal?: MultimodalConstraints;
  cwd: string;
  systemPrompt?: string;
  /** Optional addendum appended after the assembled system prompt. */
  appendSystemPrompt?: string;
  /** SDK-provided plan-mode instructions, applied only in native plan mode. */
  planModeInstructions?: string;
  /**
   * Profile-selected projection for dynamic runtime context. The native
   * compatibility default keeps it in the system prompt; `user_message`
   * makes the context an explicit durable user-role surface.
   */
  runtimeContextSurface?: RuntimeContextSurface;
  maxOutputTokens?: number;
  thinking?: CanonicalThinkingConfig;
  toolChoice?: CanonicalToolChoice;
  /** Optional model/provider-specific aliases for emitted tool names. */
  toolAliases?: Record<string, string>;
  maxContextMessages?: number;
  stopOnStructuredOutput?: boolean;
  runMode?: AgentRunMode;
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
  /** Optional default model/caps for forked subagents. Omitted means inherit this agent's model. */
  subagentModel?: {
    provider: string;
    model: string;
    modelMultimodal?: MultimodalConstraints;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  };
  /** Optional timeout budget for forked subagents spawned by the `agent` tool. */
  subagentTimeoutMs?: number;
  /** Session-scoped Agent SDK presets. Absent preserves builtin definitions. */
  subagentDefinitions?: Record<string, SubagentDefinition>;
  /** Enable automatic JSON self-correction retry on invalid_tool_arguments. Default false. */
  jsonSelfCorrect?: boolean;
  /**
   * The agent's default-model context window (tokens). Passed through so the
   * loop can compare it with the routed model's window and trigger a
   * post-routing compaction pass when the routed window is smaller.
   */
  maxContextTokens?: number;
  /** Host-owned StaffDeck SOP profile selected by the resolved deployment YAML. */
  staffDeckSop?: SopRuntimeConfig;
  /** Provider-neutral module bindings selected for this runtime generation. */
  moduleBindings?: RuntimeModuleBindings;
  /** AgentLoop binding selected for this runtime generation. */
  agentLoopBinding?: CoreModuleBinding;
};
