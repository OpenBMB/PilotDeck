import type { PermissionMode, PermissionRule } from "../../permission/index.js";

export type SessionConfigOverride = {
  cwd?: string;
  permissionMode?: PermissionMode;
  bypassAvailable?: boolean;
  canPrompt?: boolean;
  /**
   * Per-session permission rules — merged into the
   * `PermissionContext.rules` produced by `createDefaultPermissionContext`.
   * Used by Web UI bridges to translate "Permission added" (the user
   * approving a tool from a chat banner) into a real allow rule, instead
   * of flipping the whole session into bypassPermissions.
   */
  permissionRules?: {
    allow?: PermissionRule[];
    deny?: PermissionRule[];
    ask?: PermissionRule[];
  };
  /**
   * Tool names to exclude from the session's tool registry. Used by
   * Always-On phases to remove interactive/blocking tools (plan mode,
   * ask_user_question) that cannot function without a human respondent.
   */
  excludeTools?: string[];
};

/**
 * Keyed by `sessionKey`, this registry lets the AlwaysOnRuntime override the
 * `cwd` / `permissionMode` of the AgentSession created by
 * `ProjectRuntimeRegistry`. The runtime sets an entry before submitting the
 * execution turn (so its cwd points at the workspace handle and its mode is
 * `bypassPermissions`) and removes it after the turn completes.
 *
 * The registry is intentionally minimal — it does not own AgentSessions, only
 * the per-session inputs that the factory needs at creation time.
 */
export class SessionConfigOverrides {
  private readonly map = new Map<string, SessionConfigOverride>();

  set(sessionKey: string, override: SessionConfigOverride): void {
    this.map.set(sessionKey, { ...override });
  }

  get(sessionKey: string): SessionConfigOverride | undefined {
    const entry = this.map.get(sessionKey);
    return entry ? { ...entry } : undefined;
  }

  delete(sessionKey: string): void {
    this.map.delete(sessionKey);
  }

  clear(): void {
    this.map.clear();
  }
}
