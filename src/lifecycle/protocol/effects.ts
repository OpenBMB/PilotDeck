export type PilotDeckHookPermissionBehavior = "allow" | "deny" | "ask" | "passthrough";

export type PilotDeckModelRequestPatch = {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
};

import type { ArtifactContract } from "../../artifact/index.js";

export type PilotDeckPermissionRequestResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type PilotDeckHookEffect =
  | {
      type: "additional_context";
      content: string;
      source: string;
      id?: string;
      priority?: "critical" | "high" | "normal" | "low";
      ttlMs?: number;
    }
  | { type: "system_message"; content: string }
  | { type: "model_request_patch"; patch: PilotDeckModelRequestPatch }
  | { type: "artifact_contracts"; sourcePluginId: string; contracts: readonly ArtifactContract[] }
  | { type: "block"; reason: string; stopReason?: string }
  | { type: "permission_decision"; behavior: PilotDeckHookPermissionBehavior; reason?: string }
  | { type: "updated_tool_input"; input: Record<string, unknown> }
  | { type: "updated_mcp_tool_output"; output: unknown }
  | { type: "permission_request_result"; result: PilotDeckPermissionRequestResult }
  | { type: "initial_user_message"; message: string }
  | { type: "watch_paths"; paths: string[] }
  | { type: "worktree_path"; path: string }
  | { type: "retry_permission_denied" };

export type PilotDeckLifecycleError = {
  code: "hook_blocking_error" | "hook_non_blocking_error" | "hook_execution_failed" | "hook_cancelled";
  message: string;
  hookName?: string;
  exitCode?: number;
};
