import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PilotDeckPluginSourceKind } from "../protocol/plugin.js";

export type DiscoveredPluginPath = {
  path: string;
  source: PilotDeckPluginSourceKind;
};

export async function discoverPluginPaths(
  directories: Array<{ path: string; source: PilotDeckPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginPath = join(directory.path, entry);
      try {
        if ((await stat(pluginPath)).isDirectory()) {
          discovered.push({ path: pluginPath, source: directory.source });
        }
      } catch {
        continue;
      }
    }
  }
  return discovered;
}

/**
 * Discovers standalone skill directories (containing SKILL.md without plugin.json).
 * Mirrors the legacy standalone skill directory convention.
 */
export async function discoverSkillPaths(
  directories: Array<{ path: string; source: PilotDeckPluginSourceKind }>,
): Promise<DiscoveredPluginPath[]> {
  const discovered: DiscoveredPluginPath[] = [];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = join(directory.path, entry);
      try {
        if (!(await stat(skillDir)).isDirectory()) continue;
        const files = await readdir(skillDir);
        if (files.some((f) => /^skill\.md$/i.test(f))) {
          discovered.push({ path: skillDir, source: directory.source });
        }
      } catch {
        continue;
      }
    }
  }
  return discovered;
}
