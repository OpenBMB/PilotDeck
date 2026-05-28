/**
 * PILOTDECK.md instruction file discovery — multi-scope instruction hierarchy.
 *
 * Files are loaded in the following order (later = higher priority, model pays
 * more attention to content that appears later in the system prompt):
 *
 *   1. Managed     — $PILOTDECK_MANAGED_CONFIG/PILOTDECK.md
 *   2. User        — ~/.pilotdeck/PILOTDECK.md
 *   3. User rules  — ~/.pilotdeck/rules/*.md
 *   4. Project     — per directory from projectRoot toward cwd:
 *                      <dir>/PILOTDECK.md
 *                      <dir>/.pilotdeck/PILOTDECK.md
 *                      <dir>/.pilotdeck/rules/*.md
 *   5. Local       — <dir>/PILOTDECK.local.md  (private, not committed)
 *
 * Design mirrors the legacy upstream instruction-file discovery, adapted to
 * PilotDeck path conventions (~/.pilotdeck/, .pilotdeck/).
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type InstructionScope =
  | "managed"
  | "user"
  | "project"
  | "project-rules"
  | "local";

export type InstructionLayer = {
  scope: InstructionScope;
  path: string;
  content: string;
};

export class InstructionDiscovery {
  constructor(
    private readonly projectRoot: string,
    private readonly cwd: string,
    private readonly pilotHome: string,
  ) {}

  async discover(): Promise<InstructionLayer[]> {
    const layers: InstructionLayer[] = [];
    const seen = new Set<string>();

    // 1. Managed (administrator-level, e.g. /etc/pilotdeck/)
    const managedDir = process.env.PILOTDECK_MANAGED_CONFIG;
    if (managedDir) {
      await this.tryAdd(layers, seen, "managed", join(managedDir, "PILOTDECK.md"));
    }

    // 2. User-level
    await this.tryAdd(layers, seen, "user", join(this.pilotHome, "PILOTDECK.md"));
    await this.tryAddRulesDir(layers, seen, "user", join(this.pilotHome, "rules"));

    // 3–5. Project + Local — from root toward cwd (root first = lower priority)
    const dirs = this.collectDirectoryChain();
    for (const dir of dirs) {
      await this.tryAdd(layers, seen, "project", join(dir, "PILOTDECK.md"));
      await this.tryAdd(layers, seen, "project", join(dir, ".pilotdeck", "PILOTDECK.md"));
      await this.tryAddRulesDir(layers, seen, "project-rules", join(dir, ".pilotdeck", "rules"));
      await this.tryAdd(layers, seen, "local", join(dir, "PILOTDECK.local.md"));
    }

    return layers;
  }

  /**
   * Collect the directory chain from projectRoot down to cwd (inclusive).
   * Returns directories in root-first order so closer-to-cwd directories
   * are loaded last (= higher priority).
   */
  private collectDirectoryChain(): string[] {
    const root = resolve(this.projectRoot);
    const current = resolve(this.cwd);

    if (root === current) {
      return [root];
    }

    const dirs: string[] = [];
    let dir = current;
    while (dir !== root && dir !== dirname(dir)) {
      dirs.push(dir);
      dir = dirname(dir);
    }
    dirs.push(root);
    dirs.reverse();
    return dirs;
  }

  private async tryAdd(
    layers: InstructionLayer[],
    seen: Set<string>,
    scope: InstructionScope,
    filePath: string,
  ): Promise<void> {
    const resolved = resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    try {
      const content = await readFile(resolved, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        layers.push({ scope, path: resolved, content: trimmed });
      }
    } catch {
      // ENOENT / EISDIR / EACCES — all expected when files don't exist
    }
  }

  private async tryAddRulesDir(
    layers: InstructionLayer[],
    seen: Set<string>,
    scope: InstructionScope,
    dirPath: string,
  ): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const mdFiles = entries
        .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "SKILL.md")
        .map(e => e.name)
        .sort();
      for (const file of mdFiles) {
        await this.tryAdd(layers, seen, scope, join(dirPath, file));
      }
    } catch {
      // Directory doesn't exist — normal
    }
  }
}

export function scopeDescription(scope: InstructionScope): string {
  switch (scope) {
    case "managed":
      return " (managed instructions, set by administrator)";
    case "user":
      return " (user's global instructions for all projects)";
    case "project":
      return " (project instructions, checked into the codebase)";
    case "project-rules":
      return " (project rule, checked into the codebase)";
    case "local":
      return " (user's private project instructions, not checked in)";
  }
}
