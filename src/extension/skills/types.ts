/**
 * Public protocol types for the skill manager. These types are shared
 * between the gateway, its remote clients (UI server bridge), and any
 * future SDK consumer. They intentionally avoid leaking absolute paths
 * to outside callers — every operation is addressed by `(scope, slug)`
 * and the manager itself owns the path layout under `~/.pilotdeck/skills/`
 * and `<projectRoot>/.pilotdeck/skills/`.
 */

/**
 * "user" lives in `~/.pilotdeck/skills/`, available to every project.
 * "project" lives in `<projectRoot>/.pilotdeck/skills/`, scoped to the
 * project the agent is running against.
 */
export type SkillScope = "user" | "project";

/**
 * Lightweight summary used by `list` / `create` / `write` responses.
 * Mirrors what the UI needs to render a sidebar row: name +
 * description for display, slug for routing, mtime for sort. The
 * absolute path is included so the UI can show it in the detail
 * header — it's the same field SkillsV2.tsx already binds to.
 */
export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  /** Absolute path of the SKILL.md file. */
  skillFile: string;
  /** Absolute path of the containing skill directory. */
  skillDir: string;
  scope: SkillScope;
  /** Last-modified time of SKILL.md in epoch ms, or null if unreadable. */
  mtime: number | null;
};

export type SkillsListInput = {
  /**
   * Absolute path of the active project. When omitted (or set to a
   * "general chat" marker the caller filters out), only user-scope
   * skills are returned.
   */
  projectKey?: string | null;
};

export type SkillsListResult = {
  user: SkillSummary[];
  project: SkillSummary[];
  /** Echoed back so the UI can confirm which project the list came from. */
  projectPath: string | null;
};

export type SkillAddressInput = {
  scope: SkillScope;
  slug: string;
  /** Required when `scope === "project"`. */
  projectKey?: string | null;
};

export type SkillReadResult = {
  content: string;
  scope: SkillScope;
  slug: string;
  skill: SkillSummary | null;
};

export type SkillWriteInput = SkillAddressInput & { content: string };
export type SkillWriteResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
  skill: SkillSummary | null;
};

export type SkillCreateInput = SkillAddressInput & {
  name?: string;
  description?: string;
  body?: string;
  /**
   * Full SKILL.md content. When provided, name/description/body are
   * ignored. Used by the "Import from folder" flow that already has
   * a complete document to write.
   */
  content?: string;
};

export type SkillCreateResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
  /** Absolute path of the created skill directory. */
  skillPath: string;
  skill: SkillSummary | null;
};

export type SkillDeleteInput = SkillAddressInput;
export type SkillDeleteResult = {
  ok: true;
  scope: SkillScope;
  slug: string;
};

/** Issue raised by the compliance validator. */
export type SkillValidationIssue = { code: string; message: string };

export type SkillValidationResult = {
  /** False when at least one hard-fail issue is present. */
  ok: boolean;
  hardFails: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
  stats: { fileCount: number; totalBytes: number };
  /** Parsed frontmatter when the SKILL.md was readable, otherwise null. */
  frontmatter: Record<string, unknown> | null;
  /**
   * Echoed back when the validator was given an on-disk source so the
   * UI can show what was checked.
   */
  sourcePath?: string;
};

export type SkillValidateInput =
  | { sourcePath: string }
  | {
      /**
       * Raw SKILL.md content from the browser folder picker. Required when
       * `files` is provided; otherwise the validator only checks the file
       * list for size/safety.
       */
      skillMdContent?: string;
      files: Array<{ relativePath: string; size: number }>;
    };

export type SkillImportInput = {
  /**
   * Absolute path to the source folder containing SKILL.md.  Supports
   * `~` expansion at the manager level.
   */
  sourcePath: string;
  /** Defaults to the source folder basename. */
  slug?: string;
  scope: SkillScope;
  projectKey?: string | null;
  /**
   * "copy" recursively copies the source folder. "symlink" makes a
   * symlink pointing at the source — edits in either location stay in
   * sync at the cost of breaking the skill if the source moves.
   */
  mode?: "copy" | "symlink";
  /** Overwrite an existing target directory. */
  force?: boolean;
};

export type SkillImportResult = {
  ok: true;
  mode: "copy" | "symlink";
  scope: SkillScope;
  slug: string;
  sourcePath: string;
  /** Absolute path of the imported skill directory. */
  skillPath: string;
  skill: SkillSummary | null;
  validation: SkillValidationResult;
};

export type SkillScanInput = { parentPath: string };

export type SkillScanFolder = {
  folderName: string;
  hasSkillMd: boolean;
  name: string | null;
  description: string | null;
  sourcePath: string;
  fileCount: number;
  totalSize: number;
};

export type SkillScanResult = {
  parentPath: string;
  folders: SkillScanFolder[];
};
