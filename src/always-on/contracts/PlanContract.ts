import { AlwaysOnError } from "../protocol/errors.js";

/**
 * PlanContract enforces the markdown shape described in
 * `docs/always-on/02-pilotdeck-always-on-rewrite-plan.md` §7.
 *
 * Required sections, in order:
 *   1. ## Summary           single short paragraph (≤ 200 chars)
 *   2. ## Rationale         non-empty
 *   3. ## Context Signals   ≥ 1 unordered list item
 *   4. ## Proposed Change   non-empty, no fuzzy "TODO" wording
 *   5. ## Execution Steps   ≥ 1 ordered list item; ordered-only
 *   6. ## Verification      ≥ 1 unordered list item
 */

export type PlanMetadata = {
  id: string;
  sourceRunId: string;
  createdAt: string;
  projectRoot: string;
  dedupeKey: string;
};

export type PlanParseResult = {
  title: string;
  metadata: PlanMetadata;
  sections: Record<string, string[]>;
  rawContent: string;
};

export const PLAN_REQUIRED_SECTIONS: ReadonlyArray<string> = [
  "Summary",
  "Rationale",
  "Context Signals",
  "Proposed Change",
  "Execution Steps",
  "Verification",
];

export const PLAN_METADATA_FIRST_LINE = "Always-On Discovery Plan";
export const PLAN_METADATA_KEYS: ReadonlyArray<keyof PlanMetadata> = [
  "id",
  "sourceRunId",
  "createdAt",
  "projectRoot",
  "dedupeKey",
];

export type PlanContractOptions = {
  maxResultSizeChars?: number;
  fuzzyTodoPatterns?: RegExp[];
  summaryMaxChars?: number;
};

const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;
const DEFAULT_SUMMARY_MAX = 200;
const DEFAULT_FUZZY_TODOS: RegExp[] = [/^\s*TODO\b/i, /^\s*待补充\b/];

export function parsePlanMarkdown(
  content: string,
  options: PlanContractOptions = {},
): PlanParseResult {
  const max = options.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
  const summaryMax = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX;
  const fuzzyPatterns = options.fuzzyTodoPatterns ?? DEFAULT_FUZZY_TODOS;

  if (typeof content !== "string") {
    throw new AlwaysOnError("plan_invalid", "plan content must be a string.");
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/[\u00a0]/g, " ");
  if (normalized.length === 0) {
    throw new AlwaysOnError("plan_invalid", "plan content is empty.");
  }
  if (normalized.length > max) {
    throw new AlwaysOnError(
      "plan_invalid",
      `plan content exceeds maxResultSizeChars (${max}).`,
    );
  }

  const lines = normalized.split("\n");
  let cursor = 0;

  // Title.
  while (cursor < lines.length && lines[cursor].trim().length === 0) {
    cursor += 1;
  }
  const titleLine = lines[cursor] ?? "";
  if (!titleLine.startsWith("# ")) {
    throw new AlwaysOnError("plan_invalid", "plan must start with a level-1 markdown heading.");
  }
  const title = titleLine.slice(2).trim();
  if (title.length === 0) {
    throw new AlwaysOnError("plan_invalid", "plan title must not be empty.");
  }
  cursor += 1;

  while (cursor < lines.length && lines[cursor].trim().length === 0) {
    cursor += 1;
  }

  // Metadata blockquote.
  const metadataLines: string[] = [];
  while (cursor < lines.length && lines[cursor].startsWith(">")) {
    metadataLines.push(lines[cursor].replace(/^>\s?/, ""));
    cursor += 1;
  }
  if (metadataLines.length === 0) {
    throw new AlwaysOnError(
      "plan_invalid",
      "plan must include a metadata blockquote immediately after the title.",
    );
  }
  if (metadataLines[0].trim() !== PLAN_METADATA_FIRST_LINE) {
    throw new AlwaysOnError(
      "plan_invalid",
      `plan metadata blockquote first line must be "${PLAN_METADATA_FIRST_LINE}".`,
    );
  }
  const metadata = parseMetadataLines(metadataLines.slice(1));
  for (const key of PLAN_METADATA_KEYS) {
    if (metadata[key].length === 0) {
      throw new AlwaysOnError(
        "plan_invalid",
        `plan metadata is missing required key "${key}".`,
      );
    }
  }

  while (cursor < lines.length && lines[cursor].trim().length === 0) {
    cursor += 1;
  }

  // Sections.
  const sections: Record<string, string[]> = {};
  const seenSections = new Set<string>();
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentSection !== null) {
      sections[currentSection] = currentLines;
    }
    currentSection = null;
    currentLines = [];
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.startsWith("## ")) {
      flush();
      const sectionName = line.slice(3).trim();
      if (sectionName.length === 0) {
        throw new AlwaysOnError("plan_invalid", "plan section heading must not be empty.");
      }
      if (seenSections.has(sectionName)) {
        throw new AlwaysOnError(
          "plan_invalid",
          `plan contains duplicate section "${sectionName}".`,
        );
      }
      seenSections.add(sectionName);
      currentSection = sectionName;
      currentLines = [];
      continue;
    }
    if (line.startsWith("# ")) {
      throw new AlwaysOnError(
        "plan_invalid",
        "plan must contain exactly one level-1 heading at the top.",
      );
    }
    if (currentSection !== null) {
      currentLines.push(line);
    }
  }
  flush();

  // Required sections set & order.
  const orderedSections = Object.keys(sections);
  if (orderedSections.length !== PLAN_REQUIRED_SECTIONS.length) {
    throw new AlwaysOnError(
      "plan_invalid",
      `plan must contain exactly the required sections: ${PLAN_REQUIRED_SECTIONS.join(", ")}.`,
    );
  }
  for (let index = 0; index < PLAN_REQUIRED_SECTIONS.length; index += 1) {
    if (orderedSections[index] !== PLAN_REQUIRED_SECTIONS[index]) {
      throw new AlwaysOnError(
        "plan_invalid",
        `plan section #${index + 1} must be "${PLAN_REQUIRED_SECTIONS[index]}", got "${orderedSections[index]}".`,
      );
    }
  }

  // Section content checks.
  validateSummary(sections.Summary, summaryMax);
  validateRationale(sections.Rationale);
  validateContextSignals(sections["Context Signals"]);
  validateProposedChange(sections["Proposed Change"], fuzzyPatterns);
  validateExecutionSteps(sections["Execution Steps"]);
  validateVerification(sections.Verification);

  return {
    title,
    metadata: metadata as PlanMetadata,
    sections,
    rawContent: normalized.replace(/\s+$/, "") + "\n",
  };
}

function parseMetadataLines(lines: string[]): Record<keyof PlanMetadata, string> {
  const result: Record<string, string> = {
    id: "",
    sourceRunId: "",
    createdAt: "",
    projectRoot: "",
    dedupeKey: "",
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new AlwaysOnError(
        "plan_invalid",
        `plan metadata line "${line}" is not in "key: value" form.`,
      );
    }
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (!(key in result)) {
      throw new AlwaysOnError(
        "plan_invalid",
        `plan metadata contains unknown key "${key}".`,
      );
    }
    result[key] = value;
  }
  return result as Record<keyof PlanMetadata, string>;
}

function nonEmptyTextOrThrow(lines: string[], section: string): string {
  const text = lines.join("\n").trim();
  if (text.length === 0) {
    throw new AlwaysOnError("plan_invalid", `plan section "${section}" must not be empty.`);
  }
  return text;
}

function validateSummary(lines: string[], summaryMax: number): void {
  const text = nonEmptyTextOrThrow(lines, "Summary");
  if (text.length > summaryMax) {
    throw new AlwaysOnError(
      "plan_invalid",
      `plan Summary exceeds ${summaryMax} characters.`,
    );
  }
  if (text.split(/\n\s*\n/).length > 1) {
    throw new AlwaysOnError("plan_invalid", "plan Summary must be a single paragraph.");
  }
}

function validateRationale(lines: string[]): void {
  nonEmptyTextOrThrow(lines, "Rationale");
}

function validateContextSignals(lines: string[]): void {
  const items = lines.filter((line) => /^\s*-\s+/.test(line));
  if (items.length === 0) {
    throw new AlwaysOnError(
      "plan_invalid",
      "plan Context Signals must contain at least one unordered list item.",
    );
  }
}

function validateProposedChange(lines: string[], fuzzyPatterns: RegExp[]): void {
  const text = nonEmptyTextOrThrow(lines, "Proposed Change");
  for (const pattern of fuzzyPatterns) {
    if (pattern.test(text)) {
      throw new AlwaysOnError(
        "plan_invalid",
        `plan Proposed Change must not be fuzzy ("${pattern.source}").`,
      );
    }
  }
}

function validateExecutionSteps(lines: string[]): void {
  const stripped = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (stripped.length === 0) {
    throw new AlwaysOnError(
      "plan_invalid",
      "plan Execution Steps must contain at least one ordered list item.",
    );
  }
  let ordered = 0;
  for (const line of stripped) {
    if (/^\d+\.\s+/.test(line)) {
      ordered += 1;
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      throw new AlwaysOnError(
        "plan_invalid",
        "plan Execution Steps must use an ordered list (no unordered items).",
      );
    }
  }
  if (ordered === 0) {
    throw new AlwaysOnError(
      "plan_invalid",
      "plan Execution Steps must contain at least one ordered list item.",
    );
  }
}

function validateVerification(lines: string[]): void {
  const items = lines.filter((line) => /^\s*-\s+/.test(line));
  if (items.length === 0) {
    throw new AlwaysOnError(
      "plan_invalid",
      "plan Verification must contain at least one unordered list item.",
    );
  }
}
