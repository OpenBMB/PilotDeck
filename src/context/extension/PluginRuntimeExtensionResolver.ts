import type { PilotDeckLoadedPlugin } from "../../extension/index.js";
import type {
  ContributedCommand,
  ContributedSkill,
  ExtensionResolver,
  McpServerInstruction,
} from "./ExtensionResolver.js";

/**
 * Minimal runtime contract; extension owner has agreed to expose
 * `getAllCommands()` / `getAllSkills()` aggregators (review 2026-05). Until
 * those exist, we accept just `snapshot()` and flatMap manually with a TODO
 * marker.
 *
 * `ExtensionSnapshot` (turn-stable contribution view) is the long-term API;
 * this resolver will be migrated to read it once the extension owner ships it.
 */
export type PluginRuntimeLike = {
  snapshot(): PilotDeckLoadedPlugin[];
  /** Optional aggregator preferred when available. */
  getAllCommands?(): ContributedCommand[];
  getAllSkills?(): ContributedSkill[];
  /** Optional aggregator for MCP instructions. Phase 6 leaves this empty. */
  getAllMcpInstructions?(): McpServerInstruction[];
};

/**
 * Wraps a `PluginRuntime` (or compatible) so context can read plugin-derived
 * info without reaching into `PilotDeckLoadedPlugin` directly.
 *
 * Decision §3.2 — read-only resolver, no separate registry. When extension
 * owner ships the `ExtensionSnapshot` API this implementation should switch
 * to consume it (deferred `context-extension-snapshot`).
 */
export class PluginRuntimeExtensionResolver implements ExtensionResolver {
  constructor(private readonly runtime: PluginRuntimeLike) {}

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
          namespace: plugin.name,
        }),
      ),
    );
  }

  listMcpInstructions(): McpServerInstruction[] {
    if (this.runtime.getAllMcpInstructions) {
      return this.runtime.getAllMcpInstructions();
    }
    // MCP runtime not yet integrated — see deferred `context-mcp-instructions`.
    return [];
  }
}
