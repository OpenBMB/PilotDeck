import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHooksConfig } from "../../hooks/config/parseHooksConfig.js";
import type { PilotDeckPluginManifest } from "../protocol/manifest.js";
import type { PilotDeckLoadedPlugin, PilotDeckPluginSourceKind } from "../protocol/plugin.js";
import { parsePluginManifest } from "../config/parsePluginManifest.js";
import { loadPluginCommands } from "./PluginCommandLoader.js";

/**
 * Loads a standalone skill directory (containing SKILL.md) as a pseudo-plugin.
 * No plugin.json required — mirrors the legacy standalone skill directory layout.
 */
export async function loadSkillFromPath(
  skillDir: string,
  source: PilotDeckPluginSourceKind,
): Promise<PilotDeckLoadedPlugin> {
  const name = skillDir.split(/[\\/]/u).at(-1) ?? "skill";
  const skills = await loadPluginCommands({ pluginName: name, baseDir: skillDir });
  return {
    name,
    path: skillDir,
    source,
    manifest: { name, version: "0.0.0" },
    skills,
  };
}

export async function loadPluginFromPath(
  pluginPath: string,
  source: PilotDeckPluginSourceKind,
): Promise<PilotDeckLoadedPlugin> {
  const manifestPath = join(pluginPath, "plugin.json");
  const manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const hooksConfig = await loadHooksConfig(pluginPath, manifest);
  const commands = await loadConfiguredMarkdown(pluginPath, manifest.commands, "commands");
  const skills = await loadConfiguredMarkdown(pluginPath, manifest.skills, "skills");
  const outputStyles = await loadConfiguredMarkdown(pluginPath, manifest.outputStyles, "output-styles");

  return {
    name: manifest.name,
    path: pluginPath,
    source,
    manifest,
    hooksConfig,
    commands,
    skills,
    outputStyles,
    mcpServers: manifest.mcpServers,
    lspServers: manifest.lspServers,
  };
}

async function loadHooksConfig(pluginPath: string, manifest: PilotDeckPluginManifest) {
  if (typeof manifest.hooks === "object" && manifest.hooks !== null) {
    return parseHooksConfig(manifest.hooks).settings;
  }
  const hookPath = typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json";
  try {
    const raw = JSON.parse(await readFile(join(pluginPath, hookPath), "utf8")) as unknown;
    return parseHooksConfig(raw).settings;
  } catch {
    return undefined;
  }
}

async function loadConfiguredMarkdown(
  pluginPath: string,
  configured: string | string[] | undefined,
  fallbackDir: "commands" | "skills" | "output-styles",
) {
  const dirs = configured === undefined ? [fallbackDir] : Array.isArray(configured) ? configured : [configured];
  const loaded = await Promise.all(
    dirs.map((dir) => loadPluginCommands({ pluginName: "", baseDir: join(pluginPath, dir) }).catch(() => [])),
  );
  const pluginName = pluginPath.split(/[\\/]/u).at(-1) ?? "";
  return loaded.flat().map((command) => ({
    ...command,
    name: command.name.startsWith(":")
      ? `${pluginName}${command.name}`
      : command.name.replace(/^:/u, `${pluginName}:`),
  }));
}
