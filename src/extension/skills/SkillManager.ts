import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { getPilotExtensionPaths } from "../../pilot/paths.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillReadResult,
  SkillScanFolder,
  SkillScanInput,
  SkillScanResult,
  SkillScope,
  SkillSummary,
  SkillValidateInput,
  SkillValidationIssue,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "./types.js";

/**
 * Slug rules — keep tight so the directory name is safe on every
 * filesystem we ship to (mac/linux/windows) and never composes into a
 * path-traversal payload.
 */
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** Caps mirror the legacy `ui/server/routes/skills.js` limits. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const CANONICAL_SKILL_MD = "SKILL.md";
const SKILL_MD_RE = /^skill\.md$/iu;
const RISKY_EXTS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".exe",
  ".bat",
  ".cmd",
  ".dll",
  ".so",
  ".dylib",
]);

export type SkillManagerOptions = {
  /** Resolved `~/.pilotdeck` root. Required. */
  pilotHome: string;
  /**
   * "General chat" cwds we treat as not-a-real-project. Defaults to
   * `pilotHome` (~/.pilotdeck). When the caller passes a `projectKey`
   * matching one of these, the manager behaves as if no project was set —
   * only user-scope skills are visible.
   */
  generalCwdPaths?: string[];
};

/**
 * Authoritative skill-CRUD layer used by every host (gateway clients,
 * UI server, future SDK callers). Owns the on-disk layout under
 * `~/.pilotdeck/skills/` (user scope) and `<projectRoot>/.pilotdeck/skills/`
 * (project scope). Legacy third-party skill directories are intentionally
 * not consulted — conflating them with PilotDeck's layout caused the
 * UI/agent skill drift the migration fixes.
 */
export class SkillManager {
  private readonly pilotHome: string;
  private readonly generalCwdPaths: string[];

  constructor(options: SkillManagerOptions) {
    this.pilotHome = resolve(options.pilotHome);
    const defaults = [this.pilotHome];
    this.generalCwdPaths = (options.generalCwdPaths ?? defaults).map((p) => resolve(p));
  }

  // -------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------

  private userSkillsRoot(): string {
    return getPilotExtensionPaths(this.pilotHome, this.pilotHome).globalSkillsDir;
  }

  private projectSkillsRoot(projectRoot: string): string {
    return getPilotExtensionPaths(projectRoot, this.pilotHome).projectSkillsDir;
  }

  private isGeneralCwd(projectKey: string | null | undefined): boolean {
    if (!projectKey) return false;
    return this.generalCwdPaths.includes(resolve(projectKey));
  }

  /** Resolve a `(scope, slug, projectKey)` triple to a target dir. */
  private resolveScopeRoot(scope: SkillScope, projectKey: string | null | undefined): string {
    if (scope === "project") {
      if (!projectKey || this.isGeneralCwd(projectKey)) {
        throw new SkillManagerError(
          "project_required",
          "Project scope requires a real project (general chat doesn't qualify).",
        );
      }
      return this.projectSkillsRoot(projectKey);
    }
    return this.userSkillsRoot();
  }

  private resolveSkillDir(input: SkillAddressInput): string {
    if (!isValidSlug(input.slug)) {
      throw new SkillManagerError(
        "invalid_slug",
        `Invalid slug "${input.slug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      );
    }
    const root = this.resolveScopeRoot(input.scope, input.projectKey);
    return join(root, input.slug);
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async list(input: SkillsListInput): Promise<SkillsListResult> {
    const projectKey = input.projectKey ?? null;
    const effectiveProject = this.isGeneralCwd(projectKey) ? null : projectKey;

    const userSkills = await listSkillsIn(this.userSkillsRoot(), "user");
    const projectSkills = effectiveProject
      ? await listSkillsIn(this.projectSkillsRoot(effectiveProject), "project")
      : [];

    return {
      user: userSkills,
      project: projectSkills,
      projectPath: effectiveProject,
    };
  }

  async read(input: SkillAddressInput): Promise<SkillReadResult> {
    const skillDir = this.resolveSkillDir(input);
    const skillFile = await findSkillMdFile(skillDir);
    if (!skillFile) {
      throw new SkillManagerError("not_found", `SKILL.md not found at ${join(skillDir, CANONICAL_SKILL_MD)}.`);
    }
    let content: string;
    try {
      content = await fs.readFile(skillFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("not_found", `SKILL.md not found at ${skillFile}.`);
      }
      throw e;
    }
    const skill = await readSkillMeta(skillDir, input.scope);
    return { content, scope: input.scope, slug: input.slug, skill };
  }

  async write(input: SkillWriteInput): Promise<SkillWriteResult> {
    if (typeof input.content !== "string") {
      throw new SkillManagerError("invalid_input", "content (string) is required.");
    }
    const skillDir = this.resolveSkillDir(input);
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = await findSkillMdFile(skillDir) ?? join(skillDir, CANONICAL_SKILL_MD);
    await fs.writeFile(skillFile, input.content, "utf8");
    const skill = await readSkillMeta(skillDir, input.scope);
    return { ok: true, scope: input.scope, slug: input.slug, skill };
  }

  async create(input: SkillCreateInput): Promise<SkillCreateResult> {
    const skillDir = this.resolveSkillDir(input);
    let exists = false;
    try {
      await fs.access(skillDir);
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
    if (exists) {
      throw new SkillManagerError("conflict", `Skill already exists at ${skillDir}.`);
    }
    await fs.mkdir(skillDir, { recursive: true });
    const finalContent =
      typeof input.content === "string" && input.content.trim()
        ? input.content
        : buildInitialSkillContent({
            slug: input.slug,
            name: input.name,
            description: input.description,
            body: input.body,
          });
    const skillFile = join(skillDir, CANONICAL_SKILL_MD);
    await fs.writeFile(skillFile, finalContent, "utf8");
    const skill = await readSkillMeta(skillDir, input.scope);
    return {
      ok: true,
      scope: input.scope,
      slug: input.slug,
      skillPath: skillDir,
      skill,
    };
  }

  async delete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    const skillDir = this.resolveSkillDir(input);
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { ok: true, scope: input.scope, slug: input.slug };
  }

  async validate(input: SkillValidateInput): Promise<SkillValidationResult> {
    if ("sourcePath" in input && typeof input.sourcePath === "string" && input.sourcePath.trim()) {
      const resolved = resolve(expandHome(input.sourcePath.trim()));
      const result = await validateFromDisk(resolved);
      return { ...result, sourcePath: resolved };
    }
    if ("files" in input && Array.isArray(input.files)) {
      return validateFromManifest(input.skillMdContent ?? "", input.files);
    }
    throw new SkillManagerError(
      "invalid_input",
      "Provide either { sourcePath } or { skillMdContent, files: [...] }.",
    );
  }

  async import(input: SkillImportInput): Promise<SkillImportResult> {
    if (typeof input.sourcePath !== "string" || !input.sourcePath.trim()) {
      throw new SkillManagerError("invalid_input", "sourcePath is required.");
    }
    const importMode: "copy" | "symlink" = input.mode === "symlink" ? "symlink" : "copy";

    const resolvedSource = resolve(expandHome(input.sourcePath.trim()));
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(resolvedSource);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError(
          "source_missing",
          `Source path does not exist: ${resolvedSource}`,
        );
      }
      throw e;
    }
    if (!stat.isDirectory()) {
      throw new SkillManagerError(
        "source_not_directory",
        `Source path is not a directory: ${resolvedSource}`,
      );
    }
    if (!(await findSkillMdFile(resolvedSource))) {
      throw new SkillManagerError(
        "no_skill_md",
        `Source folder does not contain a SKILL.md at the root: ${resolvedSource}`,
      );
    }

    const inferredSlug = (input.slug && input.slug.trim()) || basename(resolvedSource);
    if (!isValidSlug(inferredSlug)) {
      throw new SkillManagerError(
        "invalid_slug",
        `Invalid slug "${inferredSlug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      );
    }

    const root = this.resolveScopeRoot(input.scope, input.projectKey);
    const targetDir = join(root, inferredSlug);

    if (resolve(targetDir) === resolvedSource) {
      throw new SkillManagerError(
        "self_import",
        "Source and target resolve to the same path; pick a different slug or scope.",
      );
    }

    let exists = false;
    try {
      await fs.access(targetDir);
      exists = true;
    } catch {
      /* not present, good */
    }
    if (exists && !input.force) {
      throw new SkillManagerError(
        "conflict",
        `Skill already exists at ${targetDir}. Re-run with force=true to overwrite.`,
      );
    }

    const validation = await validateFromDisk(resolvedSource);
    if (!validation.ok) {
      throw new SkillValidationError(validation);
    }

    if (exists) {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
    await fs.mkdir(root, { recursive: true });

    if (importMode === "symlink") {
      await fs.symlink(resolvedSource, targetDir, "dir");
    } else {
      await fs.cp(resolvedSource, targetDir, {
        recursive: true,
        force: true,
        dereference: false,
        errorOnExist: false,
      });
    }

    const skill = await readSkillMeta(targetDir, input.scope);
    return {
      ok: true,
      mode: importMode,
      scope: input.scope,
      slug: inferredSlug,
      sourcePath: resolvedSource,
      skillPath: targetDir,
      skill,
      validation,
    };
  }

  async scan(input: SkillScanInput): Promise<SkillScanResult> {
    if (typeof input.parentPath !== "string" || !input.parentPath.trim()) {
      throw new SkillManagerError("invalid_input", "parentPath is required.");
    }
    const resolvedRoot = resolve(expandHome(input.parentPath.trim()));
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("not_found", `Directory not found: ${resolvedRoot}`);
      }
      throw e;
    }

    const folders: SkillScanFolder[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let isDir = entry.isDirectory();
      if (!isDir) {
        try {
          const target = await fs.stat(join(resolvedRoot, entry.name));
          isDir = target.isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;

      const subDir = join(resolvedRoot, entry.name);
      let hasSkillMd = false;
      let meta: SkillSummary | null = null;
      const skillFile = await findSkillMdFile(subDir);
      if (skillFile) {
        hasSkillMd = true;
        meta = await readSkillMeta(subDir, "user");
      }

      let fileCount = 0;
      let totalSize = 0;
      if (hasSkillMd) {
        try {
          const files = await fs.readdir(subDir, { recursive: true, withFileTypes: false });
          for (const f of files) {
            try {
              const st = await fs.stat(join(subDir, String(f)));
              if (st.isFile()) {
                fileCount++;
                totalSize += st.size;
              }
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }
      }

      folders.push({
        folderName: entry.name,
        hasSkillMd,
        name: meta?.name ?? null,
        description: meta?.description ?? null,
        sourcePath: subDir,
        fileCount,
        totalSize,
      });
    }

    folders.sort((a, b) => {
      if (a.hasSkillMd !== b.hasSkillMd) return a.hasSkillMd ? -1 : 1;
      return a.folderName.localeCompare(b.folderName);
    });

    return { parentPath: resolvedRoot, folders };
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Domain error carrying a stable machine-readable `code`. Hosts convert
 * this into 4xx HTTP responses or gateway error frames.
 */
export class SkillManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SkillManagerError";
  }
}

/**
 * Specialised error wrapping a validation result that failed the
 * hard-fail checks. Hosts can surface the structured `validation` payload
 * back to the UI so the user sees which specific rules were violated.
 */
export class SkillValidationError extends SkillManagerError {
  constructor(public readonly validation: SkillValidationResult) {
    super("validation_failed", "Validation failed.");
    this.name = "SkillValidationError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug) && !slug.includes("..");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isSkillMdFileName(name: string): boolean {
  return SKILL_MD_RE.test(name);
}

function isRootSkillMdPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return !normalized.includes("/") && isSkillMdFileName(normalized);
}

async function findSkillMdFile(skillDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillDir);
  } catch {
    return null;
  }
  const name = entries.find(isSkillMdFileName);
  return name ? join(skillDir, name) : null;
}

/**
 * Build a fresh SKILL.md from user-supplied fields. We emit a minimal
 * YAML frontmatter block (just `name` and `description`) plus a markdown
 * body, matching what `ui/server/routes/skills.js` used to write so
 * exporters/diffs don't churn.
 */
function buildInitialSkillContent(input: {
  slug: string;
  name?: string;
  description?: string;
  body?: string;
}): string {
  const fmName = (input.name ?? input.slug).replace(/\n/g, " ").trim();
  const fmDesc = (input.description ?? "").replace(/\n/g, " ").trim();
  const lines: string[] = ["---", `name: ${fmName}`];
  if (fmDesc) lines.push(`description: ${fmDesc}`);
  lines.push("---", "", `# ${fmName}`, "");
  if (input.body && input.body.trim()) {
    lines.push(input.body.trim(), "");
  } else {
    lines.push(
      "Describe what this skill does, when to invoke it, and any prerequisites.",
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Parse the YAML frontmatter block at the head of `content`. Returns an
 * empty object when the document doesn't start with `---`, when the
 * closing fence is missing, or when YAML fails to parse — callers should
 * treat the skill as still loadable in those cases (we surface name +
 * description for display only).
 */
function parseSkillFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  // Accept both `\n---\n` and `\n---` (no trailing newline) closing
  // fences; some editors strip the trailing newline on save.
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) return {};
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readSkillMeta(skillDir: string, scope: SkillScope): Promise<SkillSummary | null> {
  const skillFile = await findSkillMdFile(skillDir);
  if (!skillFile) return null;
  let content: string;
  try {
    content = await fs.readFile(skillFile, "utf8");
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(content);
  let mtime: number | null = null;
  try {
    const stat = await fs.stat(skillFile);
    mtime = stat.mtimeMs;
  } catch {
    /* ignore */
  }
  return {
    slug: basename(skillDir),
    name: typeof fm.name === "string" ? fm.name : basename(skillDir),
    description: typeof fm.description === "string" ? fm.description : "",
    version:
      typeof fm.version === "string"
        ? fm.version
        : typeof fm.version === "number"
          ? String(fm.version)
          : null,
    skillFile,
    skillDir,
    scope,
    mtime,
  };
}

async function listSkillsIn(root: string, scope: SkillScope): Promise<SkillSummary[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!isValidSlug(entry.name)) continue;
    let isSkillDir = entry.isDirectory();
    if (!isSkillDir && entry.isSymbolicLink()) {
      // Accept symlinks-to-directories (the import-as-symlink path
      // creates these). Resolve and verify the target is a real dir.
      try {
        const target = await fs.stat(join(root, entry.name));
        isSkillDir = target.isDirectory();
      } catch {
        isSkillDir = false;
      }
    }
    if (!isSkillDir) continue;
    const meta = await readSkillMeta(join(root, entry.name), scope);
    if (!meta) continue;
    skills.push(meta);
  }
  skills.sort((a, b) => a.slug.localeCompare(b.slug));
  return skills;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function pushIssue(arr: SkillValidationIssue[], code: string, message: string): void {
  arr.push({ code, message });
}

function validateRequiredFrontmatter(
  skillMdContent: string,
  hardFails: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): Record<string, unknown> | null {
  if (typeof skillMdContent !== "string" || !skillMdContent.trim()) {
    pushIssue(hardFails, "no_skill_md", "SKILL.md is empty or missing.");
    return null;
  }
  const fm = parseSkillFrontmatter(skillMdContent);
  if (Object.keys(fm).length === 0 && !skillMdContent.startsWith("---")) {
    pushIssue(hardFails, "frontmatter_missing", "SKILL.md does not start with a YAML frontmatter block.");
    return fm;
  }
  if (typeof fm.name !== "string" || !fm.name.trim()) {
    pushIssue(hardFails, "frontmatter_missing_name", "Frontmatter is missing required field: name.");
  }
  if (typeof fm.description !== "string" || !fm.description.trim()) {
    pushIssue(
      hardFails,
      "frontmatter_missing_description",
      "Frontmatter is missing required field: description (skill won't surface in the slash menu without it).",
    );
  } else {
    const desc = fm.description.trim();
    if (desc.length < 20) {
      pushIssue(
        warnings,
        "description_short",
        `Description is short (${desc.length} chars). Consider expanding for better discovery.`,
      );
    }
    if (desc.length > 1024) {
      pushIssue(
        warnings,
        "description_long",
        `Description is very long (${desc.length} chars). Most slash-menu surfaces truncate this.`,
      );
    }
  }
  return fm;
}

async function validateFromDisk(sourcePath: string): Promise<SkillValidationResult> {
  const hardFails: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const stats = { fileCount: 0, totalBytes: 0 };
  let frontmatter: Record<string, unknown> | null = null;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    pushIssue(hardFails, "source_missing", `Source path does not exist: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  if (!stat.isDirectory()) {
    pushIssue(hardFails, "source_not_directory", `Source path is not a directory: ${sourcePath}`);
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }

  let skillMdContent = "";
  const skillFile = await findSkillMdFile(sourcePath);
  if (!skillFile) {
    pushIssue(hardFails, "no_skill_md", "Source folder does not contain a SKILL.md at the root.");
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  try {
    skillMdContent = await fs.readFile(skillFile, "utf8");
  } catch {
    pushIssue(hardFails, "no_skill_md", "Source folder does not contain a readable SKILL.md at the root.");
    return { ok: false, hardFails, warnings, stats, frontmatter };
  }
  frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);

  await walkDir(sourcePath, "", stats, hardFails, warnings);

  if (stats.fileCount > MAX_FILE_COUNT) {
    pushIssue(hardFails, "too_many_files", `Bundle has more than ${MAX_FILE_COUNT} files.`);
  }
  if (stats.totalBytes > MAX_TOTAL_BYTES) {
    pushIssue(
      hardFails,
      "total_too_large",
      `Bundle total size exceeds ${MAX_TOTAL_BYTES} bytes (${stats.totalBytes}).`,
    );
  }

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}

async function walkDir(
  dir: string,
  relPrefix: string,
  stats: { fileCount: number; totalBytes: number },
  hardFails: SkillValidationIssue[],
  warnings: SkillValidationIssue[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (stats.fileCount > MAX_FILE_COUNT) return;
    const rel = posix.join(relPrefix, entry.name);
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      pushIssue(warnings, "contains_symlink", `Bundle contains a symlink: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(abs, rel, stats, hardFails, warnings);
      continue;
    }
    stats.fileCount += 1;
    try {
      const fileStat = await fs.stat(abs);
      stats.totalBytes += fileStat.size;
      if (fileStat.size > MAX_FILE_BYTES) {
        pushIssue(
          hardFails,
          "file_too_large",
          `File exceeds ${MAX_FILE_BYTES} bytes: ${rel} (${fileStat.size} bytes)`,
        );
      } else if (fileStat.size > 1024 * 1024) {
        pushIssue(
          warnings,
          "file_large",
          `Large file: ${rel} (${(fileStat.size / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
    } catch {
      /* unreadable, skip */
    }
    const ext = extOf(entry.name).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      pushIssue(warnings, "risky_extension", `Executable-style file (${ext}): ${rel}`);
    }
  }
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx);
}

function validateFromManifest(
  skillMdContent: string,
  files: Array<{ relativePath: string; size: number }>,
): SkillValidationResult {
  const hardFails: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];
  const stats = { fileCount: 0, totalBytes: 0 };

  let hasSkillMd = false;
  for (const f of files) {
    const rel = typeof f.relativePath === "string" ? f.relativePath : null;
    if (!rel) continue;
    if (isRootSkillMdPath(rel)) hasSkillMd = true;
    if (rel.includes("..") || isAbsolute(rel)) {
      pushIssue(hardFails, "unsafe_path", `File path is unsafe: ${rel}`);
      continue;
    }
    const size = Number(f.size) || 0;
    stats.fileCount += 1;
    stats.totalBytes += size;
    if (size > MAX_FILE_BYTES) {
      pushIssue(
        hardFails,
        "file_too_large",
        `File exceeds ${MAX_FILE_BYTES} bytes: ${rel} (${size} bytes)`,
      );
    } else if (size > 1024 * 1024) {
      pushIssue(warnings, "file_large", `Large file: ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
    const ext = extOf(rel).toLowerCase();
    if (RISKY_EXTS.has(ext)) {
      pushIssue(warnings, "risky_extension", `Executable-style file (${ext}): ${rel}`);
    }
  }
  if (!hasSkillMd) {
    pushIssue(hardFails, "no_skill_md", "No SKILL.md at the root of the picked folder.");
  }
  if (stats.fileCount > MAX_FILE_COUNT) {
    pushIssue(hardFails, "too_many_files", `Bundle has more than ${MAX_FILE_COUNT} files.`);
  }
  if (stats.totalBytes > MAX_TOTAL_BYTES) {
    pushIssue(
      hardFails,
      "total_too_large",
      `Bundle total size exceeds ${MAX_TOTAL_BYTES} bytes (${stats.totalBytes}).`,
    );
  }

  let frontmatter: Record<string, unknown> | null = null;
  if (hasSkillMd) {
    frontmatter = validateRequiredFrontmatter(skillMdContent, hardFails, warnings);
  }

  return { ok: hardFails.length === 0, hardFails, warnings, stats, frontmatter };
}
