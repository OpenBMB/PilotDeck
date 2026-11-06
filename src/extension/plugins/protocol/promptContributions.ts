/** Prompt-facing metadata. These contracts do not expose plugin runtime resources. */
export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  /** Absolute path to the SKILL.md selected by the runtime. */
  path: string;
  namespace?: string;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

/** Fresh projection for one request; consumers must not retain it across refreshes. */
export type PluginPromptContributions = {
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  mcpInstructions: PluginMcpInstruction[];
};
