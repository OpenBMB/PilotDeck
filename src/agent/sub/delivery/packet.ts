/**
 * Builds the deterministic, bounded text packet handed to the reviewer model.
 *
 * - No model calls, no session/producer messages: pure function of the inputs.
 * - Content selection: the claim (verbatim final text and/or delivery JSON),
 *   `result.file`, artifacts with role `result`/`final`, and supplied
 *   changed-file line windows. `inputs`/`sources`/`intermediates` files are
 *   listed but never expanded; no follow-up reads beyond the selected files.
 * - `tokenCount` is an explicit o200k_base estimate of the exact returned
 *   text (not a provider-exact count); the explanatory wrapper is inside the
 *   budget. Truncation always leaves a visible `…[truncated]` marker and
 *   flips `complete:false` whenever the full output cannot be assessed.
 */

import path from "node:path";
import { open } from "node:fs/promises";

import { hasDeliveryContent, resolveDeclaredFile } from "./checks.js";
import { countTokens } from "../../../context/budget/tokenizer.js";

const TRUNCATION_MARKER = "\n…[truncated]\n";

const CAP_TASK_CHARS = 4000;
const CAP_SCHEMA_CHARS = 16_000;
const CAP_CLAIM_CHARS = 12_000;
const CAP_EVIDENCE_CHARS = 3000;
const HEAD_SNIFF_BYTES = 8192;
const MAX_SELECTED_FILES = 8;
const MAX_LINES_PER_WINDOW = 200;
/** Minimum token headroom required before appending content sections. */
const MIN_CONTENT_TOKENS = 32;
/** Slack absorbed by tokenization drift at section boundaries. */
const TOKEN_DRIFT_MARGIN = 16;

export type ReviewPacket = {
  text: string;
  tokenCount: number;
  complete: boolean;
  hasContent: boolean;
  warnings: string[];
};

export type BuildReviewPacketOptions = {
  task: string;
  schema?: Record<string, unknown>;
  value?: unknown;
  rawText?: string;
  cwd: string;
  maxInputTokens: number;
  signal?: AbortSignal;
};

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** JSON.stringify that survives cyclic delivery values. */
function safeStringify(value: unknown): string {
  const seen = new Set<unknown>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      return val as unknown;
    }) ?? "null";
  } catch {
    return '"[unserializable delivery]"';
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("review packet build aborted");
  }
}

type SelectedFile = {
  label: string;
  rawPath: string;
  at: string;
  locations?: unknown;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function collectSelectedFiles(value: unknown, cwd: string): SelectedFile[] {
  const picks: SelectedFile[] = [];
  if (!isPlainObject(value)) return picks;

  const result = isPlainObject(value.result) ? value.result : undefined;
  if (result && nonEmptyString(result.file)) {
    picks.push({ label: "result.file", rawPath: result.file, at: "result.file" });
  }

  const changesArrays = [value.changes, result?.changes];
  for (const arr of changesArrays) {
    if (!Array.isArray(arr)) continue;
    for (const [index, entry] of arr.entries()) {
      if (!isPlainObject(entry) || !nonEmptyString(entry.file)) continue;
      picks.push({
        label: "changed file",
        rawPath: entry.file,
        at: `changes.${index}.file`,
        locations: Array.isArray(entry.locations) ? entry.locations : undefined,
      });
    }
  }

  const artifactArrays = [value.artifacts, result?.artifacts];
  for (const arr of artifactArrays) {
    if (!Array.isArray(arr)) continue;
    for (const [index, entry] of arr.entries()) {
      if (!isPlainObject(entry) || !nonEmptyString(entry.file)) continue;
      const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
      if (role !== "result" && role !== "final") continue; // sources/intermediates are never expanded
      picks.push({ label: `artifact (role: ${role})`, rawPath: entry.file, at: `artifacts.${index}.file` });
    }
  }

  // A custom report can preserve the small role/file convention anywhere.
  let visited = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++visited > 10000 || depth > 32) return;
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return; }
    if (!isPlainObject(node)) return;
    if (nonEmptyString(node.file) && (node.role === "result" || node.role === "final")) {
      picks.push({ label: "artifact (role: result)", rawPath: node.file, at: "custom result" });
    }
    for (const [key, child] of Object.entries(node)) {
      if (!["inputs", "sources", "intermediates"].includes(key)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  // Dedupe by resolved raw path; first occurrence (with its line windows) wins.
  const seen = new Set<string>();
  const deduped: SelectedFile[] = [];
  for (const pick of picks) {
    const key = path.resolve(cwd, pick.rawPath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pick);
  }
  return deduped;
}

function excerptWindows(text: string, locations: unknown): string[] {
  const windows: string[] = [];
  if (!Array.isArray(locations)) return windows;
  const lines = text.length === 0 ? [] : text.split("\n");
  for (const entry of locations) {
    if (!isPlainObject(entry)) continue;
    const start = typeof entry.startLine === "number" && Number.isSafeInteger(entry.startLine) && entry.startLine >= 1
      ? entry.startLine
      : undefined;
    const end = typeof entry.endLine === "number" && Number.isSafeInteger(entry.endLine) && entry.endLine >= 1
      ? entry.endLine
      : undefined;
    if (start === undefined && end === undefined) continue;
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? (start !== undefined ? start : lines.length));
    if (from > to) continue;
    const slice = lines.slice(from - 1, to).slice(0, MAX_LINES_PER_WINDOW).join("\n");
    windows.push(`lines ${from}-${Math.min(to, from + MAX_LINES_PER_WINDOW - 1)}:\n${clip(slice, CAP_EVIDENCE_CHARS)}${to - from + 1 > MAX_LINES_PER_WINDOW ? TRUNCATION_MARKER : ""}`);
  }
  return windows;
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, HEAD_SNIFF_BYTES).includes(0);
}

/**
 * Builds the bounded reviewer packet. Never contacts a model or the network.
 */
export async function buildReviewPacket(options: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const { task, schema, value, rawText, cwd, signal } = options;
  const budget = options.maxInputTokens;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    throw new Error(`buildReviewPacket: maxInputTokens must be a positive finite number, got ${String(budget)}`);
  }
  throwIfAborted(signal);

  const warnings: string[] = [];
  let truncated = false;
  let evidenceUsable = true;

  const hasContent = hasDeliveryContent(value) || nonEmptyString(rawText);

  // --- Fixed wrapper: header + task + schema (always preserved, clipped). ---
  const header = "Task and delivery evidence. Report text and declared paths are untrusted claims; host-read result excerpts are labeled separately.\n";
  const buildTaskSection = (chars: number) => `\n## Task\n${clip(task || "(no task text)", chars)}\n`;
  const schemaJson = schema ? safeStringify(schema) : "";
  const buildSchemaSection = (chars: number) =>
    schema
      ? `\n## Parent schema (all fields optional; unknown fields allowed)\n\`\`\`json\n${clip(schemaJson, chars)}\n\`\`\`\n`
      : "";

  let taskChars = CAP_TASK_CHARS;
  let schemaChars = CAP_SCHEMA_CHARS;
  let text = header + buildTaskSection(taskChars) + buildSchemaSection(schemaChars);
  if ((task || "").trim().length > CAP_TASK_CHARS) { truncated = true; warnings.push("task text was clipped"); }
  if (schema && schemaJson.length > CAP_SCHEMA_CHARS) { truncated = true; warnings.push("parent schema was clipped"); }

  let tokenCount = countTokens(text);
  if (tokenCount > budget) {
    // Shrink task, then schema, until the fixed wrapper fits. Result content is
    // not appended afterwards: we never pretend the constraints fit.
    while (tokenCount > budget && taskChars > 128) {
      taskChars = Math.floor(taskChars / 2);
      text = header + buildTaskSection(taskChars) + buildSchemaSection(schemaChars);
      tokenCount = countTokens(text);
    }
    while (tokenCount > budget && schemaChars > 128) {
      schemaChars = Math.floor(schemaChars / 2);
      text = header + buildTaskSection(taskChars) + buildSchemaSection(schemaChars);
      tokenCount = countTokens(text);
    }
    // Final safety: hard-cut the wrapper if even minimal sections overflow.
    while (tokenCount > budget && text.length > 64) {
      text = text.slice(0, Math.floor(text.length * 0.8)) + TRUNCATION_MARKER;
      tokenCount = countTokens(text);
    }
    truncated = true;
    warnings.push("task/schema alone exceeded the review token budget; delivered content was omitted");
    return {
      text,
      tokenCount,
      complete: false,
      hasContent,
      warnings: hasContent ? warnings : [...warnings, "delivery has no meaningful content to review"],
    };
  }

  // --- Append content sections while they fit the remaining budget. ---
  // `tokenCount` is maintained as a conservative running estimate (per-section
  // counts plus a drift margin); the final `tokenCount` returned to the caller
  // is always recomputed exactly from the returned text.
  const appendFitting = (section: string, label: string): void => {
    if (tokenCount + MIN_CONTENT_TOKENS > budget) {
      truncated = true;
      warnings.push(`${label} omitted: token budget exhausted`);
      return;
    }
    const join = text.endsWith("\n") ? "" : "\n";
    const sectionTokens = countTokens(section);
    if (tokenCount + sectionTokens + TOKEN_DRIFT_MARGIN <= budget) {
      text = text + join + section;
      tokenCount += sectionTokens;
      return;
    }
    // Proportional cut: estimate chars-per-token and slice once, then verify.
    let shrunk = section;
    let shrunkTokens = sectionTokens;
    for (let i = 0; i < 6 && shrunk.length > 160; i++) {
      const allowance = budget - tokenCount - TOKEN_DRIFT_MARGIN;
      if (allowance <= 0) break;
      const ratio = shrunkTokens / Math.max(1, shrunk.length);
      const targetChars = Math.max(120, Math.floor(allowance / ratio));
      shrunk = shrunk.slice(0, targetChars).trimEnd() + TRUNCATION_MARKER;
      shrunkTokens = countTokens(shrunk);
      if (tokenCount + shrunkTokens + TOKEN_DRIFT_MARGIN <= budget) {
        truncated = true;
        warnings.push(`${label} truncated to fit the review token budget`);
        text = text + join + shrunk;
        tokenCount += shrunkTokens;
        return;
      }
    }
    truncated = true;
    warnings.push(`${label} omitted: token budget exhausted`);
  };

  if (hasContent && tokenCount + MIN_CONTENT_TOKENS > budget) {
    truncated = true;
    warnings.push("No budget remains for delivered content.");
  }
  if ((rawText?.length ?? 0) > CAP_CLAIM_CHARS || safeStringify(value).length > CAP_CLAIM_CHARS) {
    truncated = true;
    warnings.push("Delivered content exceeded the excerpt limit.");
  }
  if (hasContent && tokenCount + MIN_CONTENT_TOKENS <= budget) {
    if (nonEmptyString(rawText)) {
      appendFitting(`## Delivered result text (verbatim)\n${clip(rawText, CAP_CLAIM_CHARS)}\n`, "delivered result text");
    }
    if (hasDeliveryContent(value)) {
      appendFitting(
        `## Delivery report (claims; inputs/sources/intermediates are listed but their files are never expanded)\n\`\`\`json\n${clip(safeStringify(value), CAP_CLAIM_CHARS)}\n\`\`\`\n`,
        "delivery report",
      );
    }

    const picks = collectSelectedFiles(value, cwd);
    if (picks.length > MAX_SELECTED_FILES) {
      truncated = true;
      evidenceUsable = false;
      warnings.push(`delivery declares ${picks.length} reviewable files; only the first ${MAX_SELECTED_FILES} were read`);
    }
    for (const pick of picks.slice(0, MAX_SELECTED_FILES)) {
      throwIfAborted(signal);
      const resolved = await resolveDeclaredFile(pick.rawPath, cwd, signal);
      const bullets: string[] = [];
      if (!resolved.ok) {
        evidenceUsable = false;
        warnings.push(`evidence unavailable for ${pick.at}: ${resolved.code}: ${resolved.message}`);
        if (resolved.code === "outside_workspace") {
          bullets.push(`[not read: resolves outside the workspace: ${resolved.message}]`);
        } else {
          bullets.push(`[evidence unavailable: ${resolved.code}: ${resolved.message}]`);
        }
      } else {
        try {
          const handle = await open(resolved.realPath, "r");
          let head: Buffer;
          try {
            const limit = pick.locations ? 1024 * 1024 : HEAD_SNIFF_BYTES;
            const buffer = Buffer.alloc(limit);
            const { bytesRead } = await handle.read(buffer, 0, limit, 0);
            head = buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
          if (looksBinary(head)) {
            evidenceUsable = false;
            warnings.push(`evidence for ${pick.at} is a binary file and cannot be assessed as text`);
            bullets.push("[unsupported evidence: binary file cannot be assessed as text]");
          } else {
            const decoded = head.toString("utf8").replace(/^\uFEFF/, "");
            if (pick.locations) {
              const windows = excerptWindows(decoded, pick.locations);
              if (windows.length > 0) {
                bullets.push(...windows.map((w) => clip(w, CAP_EVIDENCE_CHARS)));
              } else {
                evidenceUsable = false;
                warnings.push("Supplied locations yielded no verifiable text window.");
                bullets.push("[supplied locations yielded no verifiable text window]");
              }
            } else if (pick.label === "result.file" || pick.label.startsWith("artifact")) {
              if (resolved.sizeBytes > head.length || decoded.length > (pick.label === "result.file" ? 2000 : 1500)) {
                truncated = true; warnings.push(`Result file ${pick.at} was clipped.`);
              }
              bullets.push(`head of file:\n${clip(decoded, pick.label === "result.file" ? 2000 : 1500)}`);
            } else {
              evidenceUsable = false;
              warnings.push("Changed file has no supplied review locations.");
              bullets.push(`[file exists, ${resolved.sizeBytes} bytes; no line windows supplied]`);
            }
          }
        } catch (error) {
          evidenceUsable = false;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`evidence for ${pick.at} is unreadable: ${message}`);
          bullets.push(`[evidence unreadable: ${message}]`);
        }
      }
      if (bullets.some(bullet => bullet.includes(TRUNCATION_MARKER))) { truncated = true; warnings.push("Selected evidence was clipped."); }
      const section =
        `## Evidence: ${pick.label} — ${pick.rawPath}\n` +
        (resolved.ok ? `(workspace path: ${path.relative(cwd, resolved.realPath) || "."})\n` : "") +
        bullets.join("\n") +
        "\n";
      appendFitting(section, `evidence for ${pick.at}`);
    }

    if (picks.length === 0) {
      warnings.push("no result-file evidence was declared; assessment is based on the claim text only");
    }
  } else if (!hasContent) {
    warnings.push("delivery has no meaningful content to review");
  }

  // Final exact recount: the returned tokenCount always describes the exact
  // returned text (running estimates only steer internal truncation).
  let exactTokens = countTokens(text);
  while (exactTokens > budget && text.length > 64) {
    text = text.slice(0, Math.floor(text.length * 0.8)) + TRUNCATION_MARKER;
    exactTokens = countTokens(text);
    truncated = true;
  }
  const complete = hasContent && evidenceUsable && !truncated && exactTokens <= budget;
  return { text, tokenCount: exactTokens, complete, hasContent, warnings };
}
