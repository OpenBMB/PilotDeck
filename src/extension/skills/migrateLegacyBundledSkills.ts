import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Tree hashes of repo skills that the old bootstrap script copied into
 * `~/.pilotdeck/skills`. These are one-time migration fingerprints, not a
 * catalogue of the currently bundled skills. Future releases load bundled
 * skills directly and therefore do not need new entries here.
 */
const KNOWN_LEGACY_BUNDLED_SKILL_HASHES: Readonly<Record<string, readonly string[]>> = {
  "browser-use": ["e955f4f0813e4735c8130c2ccab5725a35a9f5dcb9098159c35d5ecf895ab2f8"],
  docx: ["6ea15a5334a23bc920b1722b2e43974fc0a253292e745f28b5f69f4c7203efb7"],
  "frontend-slides": ["c9f3463532727bbeeb2bb641ca1da5849b88acf493b21bbedc8bbbbcf88b44d5"],
  "minimax-pdf": ["3ef2748b6ae31af92f6aa76c6b00a547658a6ea01f8a8467f0e09475a306a7de"],
};

export type LegacyBundledSkillMigrationItem = {
  slug: string;
  sourcePath: string;
  backupPath: string;
  matched: "current" | "legacy";
};

export type LegacyBundledSkillMigrationFailure = {
  slug: string;
  sourcePath: string;
  message: string;
};

export type LegacyBundledSkillMigrationReport = {
  migrated: LegacyBundledSkillMigrationItem[];
  failures: LegacyBundledSkillMigrationFailure[];
};

export type MigrateLegacyBundledSkillsOptions = {
  pilotHome: string;
  builtinSkillsRoot: string;
  backupRoot?: string;
};

/**
 * Moves copies created by the former bootstrap sync out of the user override
 * layer. A directory is migrated only when its complete tree is byte-for-byte
 * identical to either the currently bundled skill or a known historical
 * bundled tree. Modified and unknown user skills are deliberately untouched.
 */
export function migrateLegacyBundledSkillCopies(
  options: MigrateLegacyBundledSkillsOptions,
): LegacyBundledSkillMigrationReport {
  const pilotHome = resolve(options.pilotHome);
  const builtinSkillsRoot = resolve(options.builtinSkillsRoot);
  const userSkillsRoot = join(pilotHome, "skills");
  const backupRoot = resolve(
    options.backupRoot ?? join(pilotHome, "skill-backups", "legacy-bundled-v1"),
  );
  const completionMarker = join(pilotHome, ".legacy-bundled-skills-migrated-v1");
  const report: LegacyBundledSkillMigrationReport = { migrated: [], failures: [] };

  if (existsSync(completionMarker)) {
    return report;
  }

  if (!hasBundledSkills(builtinSkillsRoot)) {
    report.failures.push({
      slug: "__migration__",
      sourcePath: builtinSkillsRoot,
      message: "Bundled skills root is missing or contains no skills; legacy copies were left untouched.",
    });
    return report;
  }

  if (existsSync(userSkillsRoot)) {
    for (const entry of readdirSync(userSkillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const slug = entry.name;
      const sourcePath = join(userSkillsRoot, slug);
      if (!existsSync(join(sourcePath, "SKILL.md"))) continue;

      try {
        const sourceHash = hashDirectoryTree(sourcePath);
        const currentBuiltinPath = join(builtinSkillsRoot, slug);
        const matchesCurrent =
          existsSync(join(currentBuiltinPath, "SKILL.md")) &&
          sourceHash === hashDirectoryTree(currentBuiltinPath);
        const matchesLegacy =
          KNOWN_LEGACY_BUNDLED_SKILL_HASHES[slug]?.includes(sourceHash) ?? false;

        if (!matchesCurrent && !matchesLegacy) continue;

        mkdirSync(backupRoot, { recursive: true });
        const backupPath = availableBackupPath(backupRoot, slug, sourceHash);
        renameSync(sourcePath, backupPath);
        report.migrated.push({
          slug,
          sourcePath,
          backupPath,
          matched: matchesCurrent ? "current" : "legacy",
        });
      } catch (error) {
        report.failures.push({
          slug,
          sourcePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // This must be one-time: a user may later create an initially identical
  // override and edit it after a restart. Without a marker, that legitimate
  // override could be mistaken for an old bootstrap copy.
  if (report.failures.length === 0) {
    try {
      mkdirSync(pilotHome, { recursive: true });
      writeFileSync(completionMarker, "completed\n", "utf8");
    } catch (error) {
      report.failures.push({
        slug: "__migration__",
        sourcePath: completionMarker,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

function hasBundledSkills(root: string): boolean {
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")),
    );
  } catch {
    return false;
  }
}

/** Deterministic hash over relative path, entry type, and file/link content. */
export function hashDirectoryTree(root: string): string {
  const resolvedRoot = resolve(root);
  const entries: Array<{ path: string; type: "file" | "link" }> = [];
  collectTreeEntries(resolvedRoot, resolvedRoot, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    if (entry.type === "link") {
      hash.update(readlinkSync(join(resolvedRoot, entry.path)));
    } else {
      hash.update(readFileSync(join(resolvedRoot, entry.path)));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectTreeEntries(
  root: string,
  current: string,
  entries: Array<{ path: string; type: "file" | "link" }>,
): void {
  for (const name of readdirSync(current)) {
    const absolutePath = join(current, name);
    const stats = lstatSync(absolutePath);
    if (stats.isDirectory()) {
      collectTreeEntries(root, absolutePath, entries);
    } else if (stats.isFile()) {
      entries.push({ path: relative(root, absolutePath), type: "file" });
    } else if (stats.isSymbolicLink()) {
      entries.push({ path: relative(root, absolutePath), type: "link" });
    }
  }
}

function availableBackupPath(backupRoot: string, slug: string, hash: string): string {
  const preferred = join(backupRoot, slug);
  if (!existsSync(preferred)) return preferred;

  const hashed = join(backupRoot, `${slug}-${hash.slice(0, 12)}`);
  if (!existsSync(hashed)) return hashed;

  let suffix = 2;
  while (existsSync(`${hashed}-${suffix}`)) suffix += 1;
  return `${hashed}-${suffix}`;
}
