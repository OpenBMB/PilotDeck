import { stat } from "node:fs/promises";
import path from "node:path";
import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";
import {
  isIgnoredPath,
  normalizeRelativePath,
  runRipgrep,
  splitRipgrepLines,
} from "./filesystem/ripgrep.js";

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  "-n"?: boolean;
  "-i"?: boolean;
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
};

const DEFAULT_HEAD_LIMIT = 250;
const MAX_COLUMNS = 500;
const EXCLUDED_DIRECTORY_GLOBS = [
  "!.git",
  "!.svn",
  "!.hg",
  "!.bzr",
  "!.jj",
  "!.sl",
  "!node_modules",
  "!dist",
] as const;

export function createGrepTool(): PilotDeckToolDefinition<GrepInput> {
  return {
    name: "grep",
    aliases: ["Grep"],
    description:
      "A ripgrep-powered search tool for workspace file contents.\n\nUsage:\n- ALWAYS use `grep` for content search tasks. Do NOT invoke `grep` or `rg` through `bash` when this tool can express the search.\n- Supports full regular expressions, `type` filters, glob filters, and multiline search.\n- Output modes: `content` shows matching lines, `files_with_matches` lists file paths, and `count` shows per-file match counts.\n- `head_limit` and `offset` work in every output mode. Pass `head_limit: 0` only when you truly need unlimited results.\n- For open-ended multi-step exploration, prefer the `agent` tool's `explore` subagent instead of repeatedly broadening searches in the parent agent.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description: "The regular expression pattern to search for in file contents.",
        },
        path: {
          type: "string",
          description: "File or directory to search within. Defaults to the workspace root.",
        },
        glob: {
          type: "string",
          description:
            "Glob pattern to filter files (for example '*.js' or '*.{ts,tsx}'). Maps to ripgrep's --glob.",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description:
            "Output mode: 'content' shows matching lines, 'files_with_matches' lists file paths, and 'count' shows per-file counts. Defaults to 'files_with_matches'.",
        },
        "-B": {
          type: "integer",
          description: "Number of lines to show before each match (content mode only).",
        },
        "-A": {
          type: "integer",
          description: "Number of lines to show after each match (content mode only).",
        },
        "-C": {
          type: "integer",
          description: "Alias for context: number of lines to show before and after each match.",
        },
        context: {
          type: "integer",
          description: "Number of lines to show before and after each match (content mode only).",
        },
        "-n": {
          type: "boolean",
          description:
            "When false, hide line numbers in content mode output. Defaults to true. Ignored in other modes.",
        },
        "-i": {
          type: "boolean",
          description: "When true, perform case-insensitive matching.",
        },
        type: {
          type: "string",
          description:
            "File type to search (for example 'js', 'ts', 'py'). Maps to ripgrep's --type filter.",
        },
        head_limit: {
          type: "integer",
          description:
            "Maximum number of output entries to return. Applies to all output modes. Defaults to 250; pass 0 for unlimited.",
        },
        offset: {
          type: "integer",
          description: "Skip this many output entries before returning results.",
        },
        multiline: {
          type: "boolean",
          description:
            "When true, enable multiline mode where . matches newlines and patterns can span lines.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.path ?? ".", context, { mustExist: true });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }

      const mode = input.output_mode ?? "files_with_matches";
      const target = await resolveSearchTarget(resolved.absolutePath, resolved.relativePath);
      const stdout = await runRipgrep({
        cwd: target.cwd,
        args: buildRipgrepArgs(input, mode, target.target),
        env: context.env,
        signal: context.abortSignal,
        toolName: "grep",
      });

      if (mode === "content") {
        const parsedLines = splitRipgrepLines(stdout)
          .map((line) => parseContentLine(line))
          .filter((line) => line.type === "separator" || !isIgnoredPath(line.file));
        const renderedLines = parsedLines.map((line) =>
          line.type === "separator"
            ? line.raw
            : formatContentLine(line, target.workspaceBaseDir, input["-n"] ?? true),
        );
        const page = paginate(renderedLines, input.head_limit, input.offset);
        const files = uniqueSorted(
          parsedLines
            .filter((line): line is Extract<ParsedContentLine, { type: "content" }> => line.type === "content")
            .map((line) => toWorkspaceFile(line.file, target.workspaceBaseDir)),
        );
        return {
          content: [{ type: "text", text: page.items.join("\n") }],
          data: {
            mode,
            files,
            count: parsedLines.length,
            truncated: page.truncated,
          },
          metadata: { truncated: page.truncated },
        };
      }

      if (mode === "count") {
        const countEntries = splitRipgrepLines(stdout)
          .map((line) => parseCountEntry(line))
          .filter((entry): entry is ParsedCountEntry => entry !== undefined && !isIgnoredPath(entry.file))
          .sort((left, right) => left.file.localeCompare(right.file));
        const totalMatches = countEntries.reduce((sum, entry) => sum + entry.count, 0);
        const renderedEntries = countEntries.map((entry) => ({
          file: toWorkspaceFile(entry.file, target.workspaceBaseDir),
          text: `${toWorkspaceFile(entry.file, target.workspaceBaseDir)}:${entry.count}`,
        }));
        const page = paginate(renderedEntries, input.head_limit, input.offset);
        return {
          content: [{ type: "text", text: page.items.map((entry) => entry.text).join("\n") }],
          data: {
            mode,
            files: page.items.map((entry) => entry.file),
            count: totalMatches,
            truncated: page.truncated,
          },
          metadata: { truncated: page.truncated },
        };
      }

      const rawFiles = splitRipgrepLines(stdout)
        .map(normalizeRelativePath)
        .filter((file) => !isIgnoredPath(file));
      const sortedFiles = await sortFilesByModifiedTime(rawFiles, target.cwd);
      const workspaceFiles = sortedFiles.map((file) => toWorkspaceFile(file, target.workspaceBaseDir));
      const page = paginate(workspaceFiles, input.head_limit, input.offset);
      return {
        content: [{ type: "text", text: page.items.join("\n") }],
        data: {
          mode,
          files: page.items,
          count: workspaceFiles.length,
          truncated: page.truncated,
        },
        metadata: { truncated: page.truncated },
      };
    },
  };
}

type ParsedContentLine =
  | {
      type: "separator";
      raw: string;
    }
  | {
      type: "content";
      raw: string;
      file: string;
      separator: ":" | "-";
      lineNumber: number;
      lineSeparator: ":" | "-";
      content: string;
    };

type ParsedCountEntry = {
  file: string;
  count: number;
};

async function resolveSearchTarget(absolutePath: string, relativePath: string): Promise<{
  cwd: string;
  target: string;
  workspaceBaseDir: string;
}> {
  const fileStat = await stat(absolutePath);
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (fileStat.isDirectory()) {
    return {
      cwd: absolutePath,
      target: ".",
      workspaceBaseDir: normalizedRelativePath === "." ? "" : normalizedRelativePath,
    };
  }
  const directory = path.posix.dirname(normalizedRelativePath);
  return {
    cwd: path.dirname(absolutePath),
    target: path.basename(absolutePath),
    workspaceBaseDir: directory === "." ? "" : directory,
  };
}

function buildRipgrepArgs(
  input: GrepInput,
  mode: NonNullable<GrepInput["output_mode"]>,
  target: string,
): string[] {
  const args = ["--hidden", "--max-columns", String(MAX_COLUMNS)];
  for (const excluded of EXCLUDED_DIRECTORY_GLOBS) {
    args.push("--glob", excluded);
  }

  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (input["-i"]) {
    args.push("-i");
  }
  if (input.type) {
    args.push("--type", input.type);
  }
  for (const pattern of splitGlobPatterns(input.glob)) {
    args.push("--glob", pattern);
  }

  if (mode === "files_with_matches") {
    args.push("-l");
  } else if (mode === "count") {
    args.push("-c", "--with-filename");
  } else {
    args.push("--with-filename", "-n");
    addContextArgs(args, input);
  }

  if (input.pattern.startsWith("-")) {
    args.push("-e", input.pattern);
  } else {
    args.push(input.pattern);
  }
  args.push(target);
  return args;
}

function addContextArgs(args: string[], input: GrepInput): void {
  if (input.context !== undefined) {
    args.push("-C", String(input.context));
    return;
  }
  if (input["-C"] !== undefined) {
    args.push("-C", String(input["-C"]));
    return;
  }
  if (input["-B"] !== undefined) {
    args.push("-B", String(input["-B"]));
  }
  if (input["-A"] !== undefined) {
    args.push("-A", String(input["-A"]));
  }
}

function splitGlobPatterns(glob: string | undefined): string[] {
  if (!glob) return [];
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/).filter(Boolean)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(",").filter(Boolean));
  }
  return patterns;
}

function parseContentLine(line: string): ParsedContentLine {
  if (line === "--") {
    return { type: "separator", raw: line };
  }
  const match = line.match(/^(.*?)([:-])(\d+)([:-])(.*)$/);
  if (!match) {
    throw new PilotDeckToolRuntimeError(
      "tool_execution_failed",
      `Unexpected ripgrep content output: ${line}`,
    );
  }
  return {
    type: "content",
    raw: line,
    file: normalizeRelativePath(match[1]),
    separator: match[2] as ":" | "-",
    lineNumber: Number.parseInt(match[3], 10),
    lineSeparator: match[4] as ":" | "-",
    content: match[5],
  };
}

function formatContentLine(
  line: Extract<ParsedContentLine, { type: "content" }>,
  workspaceBaseDir: string,
  showLineNumbers: boolean,
): string {
  const file = toWorkspaceFile(line.file, workspaceBaseDir);
  if (showLineNumbers) {
    return `${file}${line.separator}${line.lineNumber}${line.lineSeparator}${line.content}`;
  }
  return `${file}${line.separator}${line.content}`;
}

function parseCountEntry(line: string): ParsedCountEntry | undefined {
  const separator = line.lastIndexOf(":");
  if (separator <= 0) {
    return undefined;
  }
  const file = normalizeRelativePath(line.slice(0, separator));
  const count = Number.parseInt(line.slice(separator + 1), 10);
  if (!Number.isFinite(count)) {
    return undefined;
  }
  return { file, count };
}

async function sortFilesByModifiedTime(files: string[], cwd: string): Promise<string[]> {
  const stats = await Promise.allSettled(files.map((file) => stat(path.join(cwd, file))));
  return files
    .map((file, index) => ({
      file,
      modifiedAt:
        stats[index]?.status === "fulfilled" ? (stats[index].value.mtimeMs ?? 0) : 0,
    }))
    .sort((left, right) => {
      const delta = right.modifiedAt - left.modifiedAt;
      return delta !== 0 ? delta : left.file.localeCompare(right.file);
    })
    .map((entry) => entry.file);
}

function paginate<T>(
  items: T[],
  headLimit: number | undefined,
  offset: number | undefined,
): { items: T[]; truncated: boolean } {
  const normalizedOffset = Math.max(0, offset ?? 0);
  if (headLimit === 0) {
    return {
      items: items.slice(normalizedOffset),
      truncated: false,
    };
  }
  const normalizedLimit = Math.max(0, headLimit ?? DEFAULT_HEAD_LIMIT);
  const page = items.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  return {
    items: page,
    truncated: items.length > normalizedOffset + normalizedLimit,
  };
}

function toWorkspaceFile(file: string, workspaceBaseDir: string): string {
  return workspaceBaseDir.length > 0
    ? path.posix.join(workspaceBaseDir, normalizeRelativePath(file))
    : normalizeRelativePath(file);
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}
