/**
 * Lightweight context-side projection of plugin-derived information.
 *
 * Phase 6 wires the real implementation against `extension/PluginRuntime`,
 * but Phase 2 already declares the interface so PromptAssembler can consume
 * it via dependency injection. Until Phase 6 lands, callers pass
 * `NullExtensionResolver`, which returns empty arrays.
 */
export type ContributedCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  /** Plugin / namespace the command belongs to. */
  namespace?: string;
};

export type ContributedSkill = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md selected by the runtime. */
  path: string;
  namespace?: string;
};

export type McpServerInstruction = {
  serverName: string;
  instructions?: string;
};

export interface ExtensionResolver {
  listCommands(): ContributedCommand[];
  listSkills(): ContributedSkill[];
  /**
   * Phase 6 returns []; the real MCP runtime wires this once the connect /
   * handshake layer is in place (see deferred `context-mcp-instructions`).
   */
  listMcpInstructions(): McpServerInstruction[];
}

export class NullExtensionResolver implements ExtensionResolver {
  listCommands(): ContributedCommand[] {
    return [];
  }
  listSkills(): ContributedSkill[] {
    return [];
  }
  listMcpInstructions(): McpServerInstruction[] {
    return [];
  }
}
