/**
 * ReportContract validates the work-report markdown shape described in
 * `docs/always-on/02-pilotdeck-always-on-rewrite-plan.md` §8.
 *
 * Unlike PlanContract this contract is forgiving — the runtime will fall back
 * by appending placeholders so downstream tooling (UI, history) can still
 * render the report. Each fallback adds an entry to the "Notes" section.
 */
import type { AlwaysOnDiscoveryOutcome, WorkspaceStrategyId } from "../protocol/types.js";

export type ReportMetadata = {
  runId: string;
  planId: string;
  startedAt: string;
  finishedAt: string;
  outcome: AlwaysOnDiscoveryOutcome;
  workspaceStrategy: WorkspaceStrategyId;
  workspaceHandle: string;
};

export type ReportParseResult = {
  title: string;
  metadata: ReportMetadata;
  sections: Record<string, string>;
  fallbacks: string[];
  rawContent: string;
};

export const REPORT_METADATA_FIRST_LINE = "Always-On Discovery Run Report";
export const REPORT_REQUIRED_SECTIONS: ReadonlyArray<string> = [
  "Plan Reference",
  "Steps Performed",
  "Files Changed",
  "Command Output",
  "Verification Results",
  "Follow-ups",
  "Notes",
];

export type BuildFallbackReportInput = {
  metadata: ReportMetadata;
  title: string;
  reason: string;
  partial?: string;
};

export function buildFallbackReport(input: BuildFallbackReportInput): string {
  const { metadata, title, reason } = input;
  const lines = [
    `# ${title} - Work Report`,
    "",
    `> ${REPORT_METADATA_FIRST_LINE}`,
    `> runId: ${metadata.runId}`,
    `> planId: ${metadata.planId}`,
    `> startedAt: ${metadata.startedAt}`,
    `> finishedAt: ${metadata.finishedAt}`,
    `> outcome: ${metadata.outcome}`,
    `> workspaceStrategy: ${metadata.workspaceStrategy}`,
    `> workspaceHandle: ${metadata.workspaceHandle}`,
    "",
    "## Plan Reference",
    "(unavailable: report tool was not invoked)",
    "",
    "## Steps Performed",
    "(empty)",
    "",
    "## Files Changed",
    "(none recorded)",
    "",
    "## Command Output",
    "(none recorded)",
    "",
    "## Verification Results",
    "- [ ] (unverified) - report tool was not invoked",
    "",
    "## Follow-ups",
    "- Investigate why AlwaysOnReportTool was not called.",
    "",
    "## Notes",
    `- fallback: ${reason}`,
  ];
  if (input.partial && input.partial.trim().length > 0) {
    lines.push("", "## Partial Tool Payload", input.partial.trim());
  }
  return lines.join("\n") + "\n";
}

export function parseReportMarkdown(
  content: string,
  metadata: ReportMetadata,
): ReportParseResult {
  const fallbacks: string[] = [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;
  const titleLine = lines[cursor] ?? "";
  let title: string;
  if (titleLine.startsWith("# ")) {
    title = titleLine.slice(2).trim();
    cursor += 1;
  } else {
    title = "Always-On Discovery Run";
    fallbacks.push("title-missing");
  }

  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;
  while (cursor < lines.length && lines[cursor].startsWith(">")) {
    cursor += 1;
  }
  while (cursor < lines.length && lines[cursor].trim().length === 0) cursor += 1;

  const sections: Record<string, string> = {};
  let currentSection: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentSection !== null) {
      sections[currentSection] = buffer.join("\n").replace(/\s+$/u, "");
    }
    currentSection = null;
    buffer = [];
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.slice(3).trim();
      buffer = [];
      continue;
    }
    if (currentSection !== null) {
      buffer.push(line);
    }
  }
  flush();

  for (const section of REPORT_REQUIRED_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(sections, section)) {
      sections[section] = section === "Notes" ? `- fallback: section-missing(${section})` : "(empty)";
      fallbacks.push(`section-missing(${section})`);
    }
  }

  if (fallbacks.length > 0) {
    const noteLines = sections.Notes.split("\n");
    for (const fallback of fallbacks) {
      const entry = `- fallback: ${fallback}`;
      if (!noteLines.includes(entry)) {
        noteLines.push(entry);
      }
    }
    sections.Notes = noteLines.join("\n");
  }

  return {
    title,
    metadata,
    sections,
    fallbacks,
    rawContent: rebuildReport(title, metadata, sections),
  };
}

export function rebuildReport(
  title: string,
  metadata: ReportMetadata,
  sections: Record<string, string>,
): string {
  const lines = [
    `# ${title}`,
    "",
    `> ${REPORT_METADATA_FIRST_LINE}`,
    `> runId: ${metadata.runId}`,
    `> planId: ${metadata.planId}`,
    `> startedAt: ${metadata.startedAt}`,
    `> finishedAt: ${metadata.finishedAt}`,
    `> outcome: ${metadata.outcome}`,
    `> workspaceStrategy: ${metadata.workspaceStrategy}`,
    `> workspaceHandle: ${metadata.workspaceHandle}`,
  ];
  for (const section of REPORT_REQUIRED_SECTIONS) {
    lines.push("", `## ${section}`, sections[section] ?? "(empty)");
  }
  // append non-required sections at the end (rare case).
  for (const key of Object.keys(sections)) {
    if (!REPORT_REQUIRED_SECTIONS.includes(key)) {
      lines.push("", `## ${key}`, sections[key]);
    }
  }
  return lines.join("\n") + "\n";
}
