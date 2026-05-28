import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { getPilotExtensionPaths } from "../../pilot/paths.js";
import { SkillManager, SkillManagerError, SkillValidationError } from "./SkillManager.js";
import type { SkillImportResult, SkillScope, SkillValidationResult } from "./types.js";

export type SkillMigrationSourceKind = "claude-code" | "openclaw" | "hermes" | "custom";
export type SkillMigrationConflictMode = "skip" | "overwrite" | "rename";

export type SkillMigrationSource = {
  kind: SkillMigrationSourceKind;
  label: string;
  path: string;
};

export type SkillMigrationItemStatus =
  | "migrated"
  | "would_migrate"
  | "skipped"
  | "conflict"
  | "error";

export type SkillMigrationItem = {
  sourceKind: SkillMigrationSourceKind;
  sourceLabel: string;
  sourcePath: string;
  destinationPath: string | null;
  slug: string;
  status: SkillMigrationItemStatus;
  reason: string;
  validation?: SkillValidationResult;
};

export type SkillMigrationReport = {
  mode: "execute" | "dry-run";
  targetRoot: string;
  sources: SkillMigrationSource[];
  summary: Record<SkillMigrationItemStatus, number>;
  items: SkillMigrationItem[];
};

export type MigrateSkillsToPilotDeckOptions = {
  pilotHome: string;
  projectRoot?: string;
  include?: Array<Exclude<SkillMigrationSourceKind, "custom">>;
  customSources?: string[];
  execute?: boolean;
  conflictMode?: SkillMigrationConflictMode;
  scope?: SkillScope;
  projectKey?: string | null;
};

const DEFAULT_INCLUDE: Array<Exclude<SkillMigrationSourceKind, "custom">> = [
  "claude-code",
  "openclaw",
  "hermes",
];
const SKILL_MD_RE = /^skill\.md$/iu;

export async function migrateSkillsToPilotDeck(
  options: MigrateSkillsToPilotDeckOptions,
): Promise<SkillMigrationReport> {
  const pilotHome = resolve(options.pilotHome);
  const scope = options.scope ?? "user";
  const projectKey = options.projectKey ?? options.projectRoot ?? null;
  const targetRoot =
    scope === "project" && projectKey
      ? getPilotExtensionPaths(resolve(projectKey), pilotHome).projectSkillsDir
      : getPilotExtensionPaths(pilotHome, pilotHome).globalSkillsDir;
  const execute = options.execute === true;
  const conflictMode = options.conflictMode ?? "skip";
  const manager = new SkillManager({ pilotHome });
  const sources = dedupeSources(buildSources(options));
  const items: SkillMigrationItem[] = [];

  for (const source of sources) {
    const skillDirs = await discoverSkillDirs(source.path);
    if (skillDirs === null) {
      items.push({
        sourceKind: source.kind,
        sourceLabel: source.label,
        sourcePath: source.path,
        destinationPath: null,
        slug: "",
        status: "skipped",
        reason: "Source directory does not exist.",
      });
      continue;
    }
    if (skillDirs.length === 0) {
      items.push({
        sourceKind: source.kind,
        sourceLabel: source.label,
        sourcePath: source.path,
        destinationPath: null,
        slug: "",
        status: "skipped",
        reason: "No immediate child skill directories with SKILL.md found.",
      });
      continue;
    }

    for (const sourcePath of skillDirs) {
      const sourceSlug = basename(sourcePath);
      if (!isValidSlug(sourceSlug)) {
        items.push({
          sourceKind: source.kind,
          sourceLabel: source.label,
          sourcePath,
          destinationPath: null,
          slug: sourceSlug,
          status: "error",
          reason: `Invalid slug "${sourceSlug}".`,
        });
        continue;
      }
      const slug = await resolveDestinationSlug(targetRoot, sourceSlug, conflictMode);
      if (slug === null) {
        items.push({
          sourceKind: source.kind,
          sourceLabel: source.label,
          sourcePath,
          destinationPath: join(targetRoot, sourceSlug),
          slug: sourceSlug,
          status: "conflict",
          reason: "Destination skill already exists.",
        });
        continue;
      }
      const destinationPath = join(targetRoot, slug);

      try {
        if (!execute) {
          const validation = await manager.validate({ sourcePath });
          if (!validation.ok) {
            items.push({
              sourceKind: source.kind,
              sourceLabel: source.label,
              sourcePath,
              destinationPath,
              slug,
              status: "error",
              reason: `validation_failed: ${validation.hardFails.map((issue) => issue.message).join("; ")}`,
              validation,
            });
            continue;
          }
          items.push({
            sourceKind: source.kind,
            sourceLabel: source.label,
            sourcePath,
            destinationPath,
            slug,
            status: "would_migrate",
            reason: slug === sourceSlug ? "Would copy skill." : `Would copy skill as ${slug}.`,
            validation,
          });
          continue;
        }

        const result = await manager.import({
          sourcePath,
          slug,
          scope,
          projectKey,
          mode: "copy",
          force: conflictMode === "overwrite",
        });
        items.push(toMigratedItem(source, result));
      } catch (error) {
        items.push(toErrorItem(source, sourcePath, destinationPath, slug, error));
      }
    }
  }

  return {
    mode: execute ? "execute" : "dry-run",
    targetRoot,
    sources,
    summary: summarize(items),
    items,
  };
}

function buildSources(options: MigrateSkillsToPilotDeckOptions): SkillMigrationSource[] {
  const home = homedir();
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : resolve(process.cwd());
  const include = options.include ?? DEFAULT_INCLUDE;
  const sources: SkillMigrationSource[] = [];

  for (const kind of include) {
    if (kind === "claude-code") {
      sources.push(
        { kind, label: "Claude Code user skills", path: join(home, ".claude", "skills") },
        { kind, label: "Claude Code project skills", path: join(projectRoot, ".claude", "skills") },
      );
    } else if (kind === "openclaw") {
      const openclawHome = join(home, ".openclaw");
      sources.push(
        { kind, label: "OpenClaw workspace skills", path: join(openclawHome, "workspace", "skills") },
        { kind, label: "OpenClaw workspace-main skills", path: join(openclawHome, "workspace-main", "skills") },
        { kind, label: "OpenClaw workspace-assistant skills", path: join(openclawHome, "workspace-assistant", "skills") },
        { kind, label: "OpenClaw managed skills", path: join(openclawHome, "skills") },
        { kind, label: "OpenClaw shared skills", path: join(home, ".agents", "skills") },
        { kind, label: "OpenClaw project shared skills", path: join(openclawHome, "workspace", ".agents", "skills") },
        { kind, label: "OpenClaw default shared skills", path: join(openclawHome, "workspace.default", ".agents", "skills") },
      );
    } else if (kind === "hermes") {
      const hermesHome = join(home, ".hermes");
      sources.push(
        { kind, label: "Hermes user skills", path: join(hermesHome, "skills") },
        { kind, label: "Hermes Claude-style skills", path: join(hermesHome, ".claude", "skills") },
        { kind, label: "Hermes agent skills", path: join(hermesHome, ".agents", "skills") },
      );
    }
  }

  for (const sourcePath of options.customSources ?? []) {
    sources.push({
      kind: "custom",
      label: "Custom skills",
      path: resolve(expandHome(sourcePath)),
    });
  }

  return sources.map((source) => ({ ...source, path: resolve(source.path) }));
}

function dedupeSources(sources: SkillMigrationSource[]): SkillMigrationSource[] {
  const seen = new Set<string>();
  const out: SkillMigrationSource[] = [];
  for (const source of sources) {
    const key = source.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

async function discoverSkillDirs(sourceRoot: string): Promise<string[] | null> {
  try {
    if (await hasSkillMdAtRoot(sourceRoot)) {
      return [sourceRoot];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    await access(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const statEntries = await readdir(sourceRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of statEntries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = join(sourceRoot, entry.name);
      try {
        if (await hasSkillMdAtRoot(skillDir)) {
          dirs.push(skillDir);
        }
      } catch {
        continue;
      }
    }
    return dirs.sort((a, b) => basename(a).localeCompare(basename(b)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasSkillMdAtRoot(directory: string): Promise<boolean> {
  const entries = await readdir(directory);
  return entries.some((entry) => SKILL_MD_RE.test(entry));
}

async function resolveDestinationSlug(
  targetRoot: string,
  sourceSlug: string,
  conflictMode: SkillMigrationConflictMode,
): Promise<string | null> {
  if (conflictMode === "overwrite") return sourceSlug;
  const target = join(targetRoot, sourceSlug);
  const exists = await pathExists(target);
  if (!exists) return sourceSlug;
  if (conflictMode === "skip") return null;

  let counter = 2;
  let candidate = `${sourceSlug}-imported`;
  while (await pathExists(join(targetRoot, candidate))) {
    candidate = `${sourceSlug}-imported-${counter}`;
    counter++;
  }
  return candidate;
}

function toMigratedItem(source: SkillMigrationSource, result: SkillImportResult): SkillMigrationItem {
  return {
    sourceKind: source.kind,
    sourceLabel: source.label,
    sourcePath: result.sourcePath,
    destinationPath: result.skillPath,
    slug: result.slug,
    status: "migrated",
    reason: "Copied skill.",
    validation: result.validation,
  };
}

function toErrorItem(
  source: SkillMigrationSource,
  sourcePath: string,
  destinationPath: string,
  slug: string,
  error: unknown,
): SkillMigrationItem {
  let reason = error instanceof Error ? error.message : String(error);
  if (error instanceof SkillManagerError) {
    reason = `${error.code}: ${error.message}`;
  }
  if (error instanceof SkillValidationError) {
    reason = `validation_failed: ${error.validation.hardFails.map((issue) => issue.message).join("; ")}`;
  }
  return {
    sourceKind: source.kind,
    sourceLabel: source.label,
    sourcePath,
    destinationPath,
    slug,
    status: "error",
    reason,
  };
}

function summarize(items: SkillMigrationItem[]): Record<SkillMigrationItemStatus, number> {
  const summary: Record<SkillMigrationItemStatus, number> = {
    migrated: 0,
    would_migrate: 0,
    skipped: 0,
    conflict: 0,
    error: 0,
  };
  for (const item of items) {
    summary[item.status] += 1;
  }
  return summary;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isValidSlug(slug: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug) && !slug.includes("..");
}
