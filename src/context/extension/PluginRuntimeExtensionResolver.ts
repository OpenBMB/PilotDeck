import type { PilotDeckLoadedPlugin } from "../../extension/index.js";
import type {
  ContributedCommand,
  ContributedSkill,
  ExtensionResolver,
  McpServerInstruction,
  PromptContributions,
} from "./ExtensionResolver.js";

/**
 * A prompt metadata projection, independent of hook/MCP process ownership.
 * Existing list aggregators and snapshot-only integrations remain compatible.
 */
export type PluginRuntimeLike = {
  snapshot(): PilotDeckLoadedPlugin[];
  getPromptContributions?(): PromptContributions;
  /** Optional aggregator preferred when available. */
  getAllCommands?(): ContributedCommand[];
  getAllSkills?(): ContributedSkill[];
  /** Optional static MCP instructions, combined with connected server instructions. */
  getAllMcpInstructions?(): McpServerInstruction[];
};

/**
 * Wraps a `PluginRuntime` (or compatible) so context can read plugin-derived
 * info without reaching into `PilotDeckLoadedPlugin` directly.
 */
export class PluginRuntimeExtensionResolver implements ExtensionResolver {
  constructor(
    private readonly runtime: PluginRuntimeLike,
    private readonly runtimeMcpInstructions: () => McpServerInstruction[] = () => [],
  ) {}

  getPromptContributions(): PromptContributions {
    const contributions = this.runtime.getPromptContributions?.();
    if (!contributions) {
      return { commands: this.listCommands(), skills: this.listSkills(), mcpInstructions: this.listMcpInstructions() };
    }
    return { ...contributions, mcpInstructions: [...contributions.mcpInstructions, ...this.runtimeMcpInstructions()] };
  }

  listCommands(): ContributedCommand[] {
    if (this.runtime.getAllCommands) {
      return this.runtime.getAllCommands();
    }
    return this.runtime.snapshot().flatMap((plugin) =>
      (plugin.commands ?? []).map(
        (command): ContributedCommand => ({
          name: command.name,
          description: typeof command.frontmatter?.description === "string" ? command.frontmatter.description : undefined,
          argumentHint:
            typeof command.frontmatter?.["argument-hint"] === "string"
              ? (command.frontmatter["argument-hint"] as string)
              : undefined,
          namespace: plugin.name,
        }),
      ),
    );
  }

  listSkills(): ContributedSkill[] {
    if (this.runtime.getAllSkills) {
      return this.runtime.getAllSkills();
    }
    return this.runtime.snapshot().flatMap((plugin) =>
      (plugin.skills ?? []).map(
        (skill): ContributedSkill => ({
          name: skill.name,
          description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : undefined,
          path: skill.path,
          namespace: plugin.name,
        }),
      ),
    );
  }

  listMcpInstructions(): McpServerInstruction[] {
    return [
      ...(this.runtime.getAllMcpInstructions?.() ?? []),
      ...this.runtimeMcpInstructions(),
    ];
  }
}
