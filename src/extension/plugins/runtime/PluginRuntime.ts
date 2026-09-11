import { resolvePluginDirectories } from "../discovery/PluginDirectoryResolver.js";
import { discoverPluginPaths, discoverSkillPaths } from "../discovery/discoverLocalPlugins.js";
import { loadPluginFromPath, loadPluginOutputStylesFromPath, loadSkillFromPath } from "../loading/PluginLoader.js";
import { loadPluginHooks } from "../loading/PluginHookLoader.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { PilotDeckLoadedPlugin } from "../protocol/plugin.js";
import { PluginRegistry } from "./PluginRegistry.js";
import { truncateMcpInstructionString } from "./truncateMcpString.js";
import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { PilotDeckCustomRouter } from "../../../router/customRouter/customRouter.js";
import { renderSkillContent } from "../../skills/renderSkillContent.js";

/**
 * Static MCP server contribution shape callers can rely on. Manifests load
 * `mcpServers` as `Record<string, unknown>` to stay forward-compatible, so
 * this type is *advisory* — the runtime only reads `instructions` and falls
 * back gracefully when missing.
 */
export type PilotDeckMcpServerStaticSpec = {
  instructions?: string;
  [key: string]: unknown;
};

/**
 * Aggregated B3 instruction entry (always non-empty `instructions`). Exposed
 * as a stricter alias of {@link PluginMcpInstruction} so callers that only
 * care about *populated* entries keep a non-optional `instructions` field.
 */
export type PilotDeckMcpInstructionEntry = {
  serverName: string;
  instructions: string;
};

export type PluginRuntimeOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Read-only skills shipped with the active PilotDeck build. */
  builtinSkillsRoot?: string;
  builtinPlugins?: PilotDeckLoadedPlugin[];
  builtinPluginsEnabled?: Record<string, boolean>;
};

export type PluginRefreshResult = {
  previous: PilotDeckLoadedPlugin[];
  next: PilotDeckLoadedPlugin[];
  added: PilotDeckLoadedPlugin[];
  removed: PilotDeckLoadedPlugin[];
};

export type PluginCommandContribution = {
  name: string;
  description?: string;
  argumentHint?: string;
  namespace?: string;
};

export type PluginSkillContribution = {
  name: string;
  description?: string;
  /** Absolute path to the resolved SKILL.md. */
  path: string;
  namespace?: string;
};

export type PluginMcpInstruction = {
  serverName: string;
  instructions?: string;
};

export type PluginContributionSnapshot = {
  plugins: PilotDeckLoadedPlugin[];
  commands: PluginCommandContribution[];
  skills: PluginSkillContribution[];
  outputStyles: LoadedPluginCommand[];
  hooks: PilotDeckHooksSettings;
  mcpServers: Record<string, unknown>;
  lspServers: Record<string, unknown>;
  mcpInstructions: PluginMcpInstruction[];
};

export type OutputStyleContribution = {
  name: string;
  description?: string;
  content: string;
  path: string;
  plugin?: string;
  source?: PilotDeckLoadedPlugin["source"];
};

/**
 * Read-only contribution view over a fixed plugin set.
 *
 * Gateway SDK sessions use this to add Gateway-local plugins without
 * modifying the project's shared PluginRuntime registry. The view deliberately
 * reuses the ordinary contribution loading and resolution rules; it only
 * changes which already-loaded plugin records are visible to one session.
 */
export class PluginRuntimeView {
  constructor(private readonly plugins: readonly PilotDeckLoadedPlugin[]) {}

  snapshot(): PilotDeckLoadedPlugin[] {
    return [...this.plugins];
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.plugins.map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  getAllMcpInstructions(): PilotDeckMcpInstructionEntry[] {
    const entries: PilotDeckMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.plugins) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName) || !raw || typeof raw !== "object") continue;
        const instructions = (raw as PilotDeckMcpServerStaticSpec).instructions;
        if (typeof instructions !== "string" || instructions.trim().length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(instructions.trim()),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
  }

  snapshotContributions(): PluginContributionSnapshot {
    return {
      plugins: this.snapshot(),
      commands: this.plugins.flatMap((plugin) => (plugin.commands ?? []).map((command) => toCommandContribution(plugin, command))),
      skills: collectSkillContributions(this.snapshot()),
      outputStyles: this.listOutputStyles().map((style) => ({
        name: style.name,
        path: style.path,
        content: style.content,
        frontmatter: {
          ...(style.description ? { description: style.description } : {}),
        },
        isSkill: false,
      })),
      hooks: loadPluginHooks(this.snapshot()),
      mcpServers: this.mcpServers(),
      lspServers: Object.assign({}, ...this.plugins.map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>,
      mcpInstructions: this.getAllMcpInstructions(),
    };
  }

  listOutputStyles(): OutputStyleContribution[] {
    const styles = new Map<string, OutputStyleContribution>();
    for (const plugin of this.plugins) {
      for (const style of plugin.outputStyles ?? []) {
        styles.set(style.name, toOutputStyle(plugin, style));
      }
    }
    return [...styles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getOutputStyle(name: string): OutputStyleContribution | undefined {
    return this.listOutputStyles().find((style) => style.name === name);
  }

  getAllCommands(): PluginCommandContribution[] {
    return this.snapshotContributions().commands;
  }

  getAllSkills(): PluginSkillContribution[] {
    return this.snapshotContributions().skills;
  }

  lookupRouter(extensionId: string): PilotDeckCustomRouter | undefined {
    for (const plugin of this.plugins) {
      for (const contribution of plugin.routerContributions ?? []) {
        if (contribution.id === extensionId) return contribution.createCustomRouter();
      }
    }
    return undefined;
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority(this.snapshot());

    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find((contribution) => contribution.name === extensionId);
      if (prompt) return prompt.content;
    }
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name === extensionId);
      if (skill) return renderSkillContent(skill.content, skill.path);
    }
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name.endsWith(`:${extensionId}`));
      if (skill) return renderSkillContent(skill.content, skill.path);
    }
    for (const plugin of plugins) {
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) return command.content;
    }
    return undefined;
  }
}

export class PluginRuntime {
  private readonly registry = new PluginRegistry();
  private readonly outputStyleRegistry = new Map<string, OutputStyleContribution>();

  constructor(private readonly options: PluginRuntimeOptions) {}

  snapshot(): PilotDeckLoadedPlugin[] {
    return this.registry.list();
  }

  /**
   * Creates an isolated read-only contribution view. It never writes to this
   * runtime's registry and is therefore safe to use for one SDK session.
   */
  createView(additional: readonly PilotDeckLoadedPlugin[] = []): PluginRuntimeView {
    return new PluginRuntimeView([...this.registry.list(), ...additional]);
  }

  mcpServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.mcpServers ?? {})) as Record<string, unknown>;
  }

  /**
   * Read-only static instructions aggregator (deferred-feature §5.3 / B3).
   * - Iterates `mcpServers` from every loaded plugin.
   * - Filters entries with a non-empty `instructions: string` field.
   * - Truncates each entry to {@link truncateMcpInstructionString} (2048 chars).
   * - Returns a stable list sorted by `serverName` (avoids prompt-cache thrash).
   *
   * Once C1 (real MCP runtime) lands, the runtime can layer dynamic
   * instructions on top via the same `getAllMcpInstructions` aggregator
   * surface used by `PluginRuntimeExtensionResolver`.
   */
  getAllMcpInstructions(): PilotDeckMcpInstructionEntry[] {
    const entries: PilotDeckMcpInstructionEntry[] = [];
    const seen = new Set<string>();
    for (const plugin of this.registry.list()) {
      const servers = plugin.mcpServers;
      if (!servers || typeof servers !== "object") continue;
      for (const [serverName, raw] of Object.entries(servers)) {
        if (seen.has(serverName)) continue;
        if (!raw || typeof raw !== "object") continue;
        const candidate = (raw as PilotDeckMcpServerStaticSpec).instructions;
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        seen.add(serverName);
        entries.push({
          serverName,
          instructions: truncateMcpInstructionString(trimmed),
        });
      }
    }
    entries.sort((a, b) => a.serverName.localeCompare(b.serverName));
    return entries;
  }

  lspServers(): Record<string, unknown> {
    return Object.assign({}, ...this.registry.list().map((plugin) => plugin.lspServers ?? {})) as Record<string, unknown>;
  }

  snapshotContributions(): PluginContributionSnapshot {
    const plugins = this.registry.list();
    return {
      plugins,
      commands: plugins.flatMap((plugin) => (plugin.commands ?? []).map((command) => toCommandContribution(plugin, command))),
      skills: collectSkillContributions(plugins),
      outputStyles: [...this.outputStyleRegistry.values()].map((style) => ({
        name: style.name,
        path: style.path,
        content: style.content,
        frontmatter: {
          ...(style.description ? { description: style.description } : {}),
        },
        isSkill: false,
      })),
      hooks: loadPluginHooks(plugins),
      mcpServers: this.mcpServers(),
      lspServers: this.lspServers(),
      mcpInstructions: this.getAllMcpInstructions(),
    };
  }

  listOutputStyles(): OutputStyleContribution[] {
    return [...this.outputStyleRegistry.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((style) => ({ ...style }));
  }

  getOutputStyle(name: string): OutputStyleContribution | undefined {
    const style = this.outputStyleRegistry.get(name);
    return style ? { ...style } : undefined;
  }

  /**
   * Refresh only output-style files. Other plugin contributions stay in the
   * existing registry, so a style reload cannot change hooks, commands, MCP,
   * skills, or routers for an active project runtime.
   */
  async reloadOutputStyles(): Promise<{ changed: string[] }> {
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
    });
    const discovered = await discoverPluginPaths([
      { path: paths.globalPluginsDir, source: "global" },
      { path: paths.projectPluginsDir, source: "project" },
    ]);
    const next = new Map<string, OutputStyleContribution>();
    for (const plugin of this.options.builtinPlugins ?? []) {
      for (const style of plugin.outputStyles ?? []) {
        next.set(style.name, toOutputStyle(plugin, style));
      }
    }
    for (const plugin of discovered) {
      try {
        const loaded = await loadPluginOutputStylesFromPath(plugin.path, plugin.source);
        for (const style of loaded.outputStyles) {
          next.set(style.name, {
            name: style.name,
            description: typeof style.frontmatter.description === "string" ? style.frontmatter.description : undefined,
            content: style.content,
            path: style.path,
            plugin: loaded.name,
            source: loaded.source,
          });
        }
      } catch {
        // A malformed style is omitted from the new registry; unrelated
        // plugin contributions remain available and are not reloaded.
      }
    }
    const changed = [...new Set([
      ...this.outputStyleRegistry.keys(),
      ...next.keys(),
    ])].filter((key) => JSON.stringify(this.outputStyleRegistry.get(key)) !== JSON.stringify(next.get(key)));
    this.outputStyleRegistry.clear();
    for (const [key, style] of next) this.outputStyleRegistry.set(key, style);
    return { changed };
  }

  getAllCommands(): PluginCommandContribution[] {
    return this.snapshotContributions().commands;
  }

  getAllSkills(): PluginSkillContribution[] {
    return this.snapshotContributions().skills;
  }

  lookupRouter(extensionId: string): PilotDeckCustomRouter | undefined {
    for (const plugin of this.registry.list()) {
      for (const contribution of plugin.routerContributions ?? []) {
        if (contribution.id !== extensionId) {
          continue;
        }
        return contribution.createCustomRouter();
      }
    }
    return undefined;
  }

  async loadSkillPrompt(extensionId: string): Promise<string | undefined> {
    const plugins = sortByResolutionPriority(this.registry.list());

    for (const plugin of plugins) {
      const prompt = plugin.promptContributions?.find((contribution) => contribution.name === extensionId);
      if (prompt) {
        return prompt.content;
      }
    }

    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name === extensionId);
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    // Resolve namespaced plugin skills by their short name only after exact
    // standalone names have had a chance to resolve.
    for (const plugin of plugins) {
      const skill = plugin.skills?.find((entry) => entry.name.endsWith(`:${extensionId}`));
      if (skill) {
        return renderSkillContent(skill.content, skill.path);
      }
    }

    for (const plugin of plugins) {
      const command = plugin.commands?.find((entry) => entry.name === extensionId || entry.name.endsWith(`:${extensionId}`));
      if (command) {
        return command.content;
      }
    }
    return undefined;
  }

  async refresh(): Promise<PilotDeckLoadedPlugin[]> {
    return (await this.refreshWithReport()).next;
  }

  async refreshWithReport(): Promise<PluginRefreshResult> {
    const previous = this.registry.list();
    const paths = resolvePluginDirectories({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
    });
    const [discovered, discoveredSkills] = await Promise.all([
      discoverPluginPaths([
        { path: paths.globalPluginsDir, source: "global" },
        { path: paths.projectPluginsDir, source: "project" },
      ]),
      discoverSkillPaths([
        ...(this.options.builtinSkillsRoot
          ? [{ path: this.options.builtinSkillsRoot, source: "builtin" as const }]
          : []),
        { path: paths.globalSkillsDir, source: "global" },
        { path: paths.projectSkillsDir, source: "project" },
      ]),
    ]);
    const [loaded, loadedSkills] = await Promise.all([
      Promise.all(
        discovered.map((plugin) => loadPluginFromPath(plugin.path, plugin.source).catch(() => undefined)),
      ),
      Promise.all(
        discoveredSkills.map((s) => loadSkillFromPath(s.path, s.source).catch(() => undefined)),
      ),
    ]);
    const plugins = [
      ...enabledBuiltinPlugins(this.options.builtinPlugins ?? [], this.options.builtinPluginsEnabled ?? {}),
      ...loaded.filter(isLoadedPlugin),
      ...loadedSkills.filter(isLoadedPlugin),
    ];
    this.registry.replaceAll(plugins);
    this.outputStyleRegistry.clear();
    for (const plugin of plugins) {
      for (const style of plugin.outputStyles ?? []) {
        this.outputStyleRegistry.set(style.name, toOutputStyle(plugin, style));
      }
    }
    return {
      previous,
      next: plugins,
      added: plugins.filter((plugin) => !hasPlugin(previous, plugin)),
      removed: previous.filter((plugin) => !hasPlugin(plugins, plugin)),
    };
  }
}

function toOutputStyle(plugin: PilotDeckLoadedPlugin, style: LoadedPluginCommand): OutputStyleContribution {
  return {
    name: style.name,
    description: typeof style.frontmatter.description === "string" ? style.frontmatter.description : undefined,
    content: style.content,
    path: style.path,
    plugin: plugin.name,
    source: plugin.source,
  };
}

function isLoadedPlugin(value: PilotDeckLoadedPlugin | undefined): value is PilotDeckLoadedPlugin {
  return value !== undefined;
}

function enabledBuiltinPlugins(
  plugins: PilotDeckLoadedPlugin[],
  enabled: Record<string, boolean>,
): PilotDeckLoadedPlugin[] {
  return plugins.filter((plugin) => plugin.source !== "builtin" || enabled[plugin.name] !== false);
}

function hasPlugin(plugins: PilotDeckLoadedPlugin[], plugin: PilotDeckLoadedPlugin): boolean {
  return plugins.some((candidate) => candidate.name === plugin.name && candidate.source === plugin.source);
}

function toCommandContribution(
  plugin: PilotDeckLoadedPlugin,
  command: LoadedPluginCommand,
): PluginCommandContribution {
  return {
    name: command.name,
    description: typeof command.frontmatter.description === "string" ? command.frontmatter.description : undefined,
    argumentHint:
      typeof command.frontmatter["argument-hint"] === "string"
        ? command.frontmatter["argument-hint"]
        : undefined,
    namespace: plugin.name,
  };
}

function toSkillContribution(
  plugin: PilotDeckLoadedPlugin,
  skill: LoadedPluginCommand,
): PluginSkillContribution {
  return {
    name: skill.name,
    description: typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : undefined,
    path: skill.path,
    namespace: plugin.name,
  };
}

function sourcePriority(source: PilotDeckLoadedPlugin["source"]): number {
  switch (source) {
    case "project":
      return 2;
    case "global":
      return 1;
    case "builtin":
    default:
      return 0;
  }
}

function sortByResolutionPriority(plugins: PilotDeckLoadedPlugin[]): PilotDeckLoadedPlugin[] {
  return [...plugins].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
}

function collectSkillContributions(plugins: PilotDeckLoadedPlugin[]): PluginSkillContribution[] {
  const selected = new Map<string, { contribution: PluginSkillContribution; priority: number }>();
  for (const plugin of plugins) {
    const priority = sourcePriority(plugin.source);
    for (const skill of plugin.skills ?? []) {
      const contribution = toSkillContribution(plugin, skill);
      const existing = selected.get(contribution.name);
      if (!existing || priority >= existing.priority) {
        selected.set(contribution.name, { contribution, priority });
      }
    }
  }
  return [...selected.values()].map((entry) => entry.contribution);
}
