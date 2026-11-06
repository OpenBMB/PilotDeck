import type { PluginPromptContributions } from "../../extension/plugins/protocol/promptContributions.js";
export type {
  PluginCommandContribution as ContributedCommand,
  PluginSkillContribution as ContributedSkill,
  PluginMcpInstruction as McpServerInstruction,
  PluginPromptContributions as PromptContributions,
} from "../../extension/plugins/protocol/promptContributions.js";

/** Read-only context boundary. Legacy list providers remain supported. */
export interface ExtensionResolver {
  getPromptContributions?(): PluginPromptContributions;
  listCommands(): PluginPromptContributions["commands"];
  listSkills(): PluginPromptContributions["skills"];
  listMcpInstructions(): PluginPromptContributions["mcpInstructions"];
}

export class NullExtensionResolver implements ExtensionResolver {
  listCommands(): PluginPromptContributions["commands"] {
    return [];
  }
  listSkills(): PluginPromptContributions["skills"] {
    return [];
  }
  listMcpInstructions(): PluginPromptContributions["mcpInstructions"] {
    return [];
  }
}
