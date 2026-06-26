import { spawn } from "node:child_process";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { parseFragment as parseHtmlFragment, type ParserError } from "parse5";
import { LineCounter, parseDocument } from "yaml";

type SyntaxDiagnostic = {
  line: number;
  column: number;
  message: string;
};

type CheckerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const MAX_DIAGNOSTICS = 3;
const CHECKER_TIMEOUT_MS = 2_000;
const MAX_CHECKER_OUTPUT_BYTES = 16_384;
const JAVASCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyw"]);
const BASH_EXTENSIONS = new Set([".bash", ".sh"]);
const BASH_FILENAMES = new Set([
  ".bash_login",
  ".bash_profile",
  ".bashrc",
  ".profile",
]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const CSV_EXTENSIONS = new Set([".csv", ".tsv"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

const PYTHON_SYNTAX_CHECKER = `
import json
import sys

filename = sys.argv[1] if len(sys.argv) > 1 else "<stdin>"
source = sys.stdin.read()

try:
    compile(source, filename, "exec")
except SyntaxError as exc:
    print(json.dumps({
        "line": exc.lineno or 1,
        "column": exc.offset or 1,
        "message": exc.msg or "Invalid Python syntax."
    }))
    sys.exit(1)
except ValueError as exc:
    print(json.dumps({
        "line": 1,
        "column": 1,
        "message": str(exc)
    }))
    sys.exit(1)
`.trim();

export async function formatSyntaxDiagnostics(
  filePath: string,
  content: string,
): Promise<string | undefined> {
  try {
    const diagnostics = await collectSyntaxDiagnostics(filePath, content);
    if (diagnostics.length === 0) {
      return undefined;
    }
    return [
      "Syntax issues detected:",
      ...diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) =>
        `- L${diagnostic.line}:${diagnostic.column} error: ${diagnostic.message}`
      ),
    ].join("\n");
  } catch {
    return undefined;
  }
}

async function collectSyntaxDiagnostics(
  filePath: string,
  content: string,
): Promise<SyntaxDiagnostic[]> {
  const extension = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  if (extension === ".json") {
    return collectJsonDiagnostics(content);
  }
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return await collectTypeScriptDiagnostics(filePath, content, extension);
  }
  if (PYTHON_EXTENSIONS.has(extension)) {
    return await collectPythonDiagnostics(filePath, content);
  }
  if (BASH_EXTENSIONS.has(extension) || BASH_FILENAMES.has(filename)) {
    return await collectBashDiagnostics(content);
  }
  if (YAML_EXTENSIONS.has(extension)) {
    return collectYamlDiagnostics(content);
  }
  if (HTML_EXTENSIONS.has(extension)) {
    return collectHtmlDiagnostics(content);
  }
  if (CSV_EXTENSIONS.has(extension)) {
    return collectCsvDiagnostics(content, extension);
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return collectMarkdownDiagnostics(content);
  }
  return [];
}

function collectJsonDiagnostics(content: string): SyntaxDiagnostic[] {
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Invalid JSON.";
    const position = parseJsonErrorPosition(rawMessage) ?? content.length;
    const explicitLocation = parseJsonLineColumn(rawMessage);
    const location = explicitLocation ?? positionToLineColumn(content, position);
    return [{
      ...location,
      message: trimDiagnosticMessage(rawMessage),
    }];
  }
}

async function collectTypeScriptDiagnostics(
  filePath: string,
  content: string,
  extension: string,
): Promise<SyntaxDiagnostic[]> {
  const ts = await import("typescript").catch(() => undefined);
  if (!ts) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForExtension(extension, ts),
  );

  const parseDiagnostics =
    (sourceFile as { parseDiagnostics?: readonly import("typescript").Diagnostic[] }).parseDiagnostics ?? [];

  return parseDiagnostics.map((diagnostic) => {
    const start = typeof diagnostic.start === "number" ? diagnostic.start : 0;
    const location = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      line: location.line + 1,
      column: location.character + 1,
      message: trimDiagnosticMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    };
  });
}

async function collectPythonDiagnostics(
  filePath: string,
  content: string,
): Promise<SyntaxDiagnostic[]> {
  const result = await runChecker("python3", ["-c", PYTHON_SYNTAX_CHECKER, filePath], content);
  if (!result || result.timedOut || result.code === 0) {
    return [];
  }
  const parsed = parseJsonObject(result.stdout);
  if (!parsed) {
    return [];
  }
  return [{
    line: positiveInteger(parsed.line) ?? 1,
    column: positiveInteger(parsed.column) ?? 1,
    message: trimDiagnosticMessage(stringValue(parsed.message) ?? "Invalid Python syntax."),
  }];
}

async function collectBashDiagnostics(content: string): Promise<SyntaxDiagnostic[]> {
  const result = await runChecker("bash", ["-n", "-s"], content);
  if (!result || result.timedOut || result.code === 0) {
    return [];
  }
  const stderr = result.stderr.trim();
  if (stderr.length === 0) {
    return [];
  }
  return [diagnosticFromBashStderr(stderr)];
}

function collectYamlDiagnostics(content: string): SyntaxDiagnostic[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, {
    lineCounter,
    prettyErrors: false,
  });
  return document.errors.map((error) => {
    const offset = Array.isArray(error.pos) && typeof error.pos[0] === "number"
      ? error.pos[0]
      : 0;
    const location = lineCounter.linePos(offset);
    return {
      line: location.line,
      column: location.col,
      message: trimDiagnosticMessage(error.message),
    };
  });
}

function collectHtmlDiagnostics(content: string): SyntaxDiagnostic[] {
  const errors: ParserError[] = [];
  parseHtmlFragment(content, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(error),
  });
  return errors.map((error) => ({
    line: positiveInteger(error.startLine) ?? 1,
    column: positiveInteger(error.startCol) ?? 1,
    message: trimDiagnosticMessage(`HTML parse error: ${error.code}`),
  }));
}

function collectCsvDiagnostics(content: string, extension: string): SyntaxDiagnostic[] {
  try {
    parseCsv(content, {
      bom: true,
      delimiter: extension === ".tsv" ? "\t" : ",",
      skip_empty_lines: true,
    });
    return [];
  } catch (error) {
    const record = isRecord(error) ? error : {};
    return [{
      line: positiveInteger(record.lines) ?? 1,
      column: positiveInteger(record.column) ?? 1,
      message: trimDiagnosticMessage(stringValue(record.message) ?? "Invalid CSV syntax."),
    }];
  }
}

function collectMarkdownDiagnostics(content: string): SyntaxDiagnostic[] {
  return [
    ...collectMarkdownFrontmatterDiagnostics(content),
    ...collectMarkdownFenceDiagnostics(content),
  ];
}

function collectMarkdownFrontmatterDiagnostics(content: string): SyntaxDiagnostic[] {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return [];
  }

  const closingIndex = lines.findIndex((line, index) =>
    index > 0 && (line.trim() === "---" || line.trim() === "...")
  );

  if (closingIndex < 0) {
    const looksLikeFrontmatter = lines
      .slice(1, Math.min(lines.length, 40))
      .some((line) => /^[A-Za-z0-9_.-]+\s*:/u.test(line.trim()));
    if (!looksLikeFrontmatter) {
      return [];
    }
    return [{
      line: 1,
      column: 1,
      message: "YAML frontmatter is opened with --- but no closing delimiter was found.",
    }];
  }

  const frontmatter = lines.slice(1, closingIndex).join("\n");
  if (frontmatter.trim().length === 0) {
    return [];
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(frontmatter, {
    lineCounter,
    prettyErrors: false,
  });

  return document.errors.map((error) => {
    const offset = Array.isArray(error.pos) && typeof error.pos[0] === "number"
      ? error.pos[0]
      : 0;
    const location = lineCounter.linePos(offset);
    return {
      line: location.line + 1,
      column: location.col,
      message: trimDiagnosticMessage(`YAML frontmatter: ${error.message}`),
    };
  });
}

function collectMarkdownFenceDiagnostics(content: string): SyntaxDiagnostic[] {
  const lines = content.split(/\r?\n/u);
  let openFence: { marker: "`" | "~"; length: number; line: number; column: number } | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!openFence) {
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
      if (!match) {
        continue;
      }
      const fence = match[2] ?? "";
      const rest = match[3] ?? "";
      if (fence[0] === "`" && rest.includes("`")) {
        continue;
      }
      openFence = {
        marker: fence[0] as "`" | "~",
        length: fence.length,
        line: index + 1,
        column: (match[1]?.length ?? 0) + 1,
      };
      continue;
    }

    const closingMatch = /^( {0,3})(`{3,}|~{3,})\s*$/u.exec(line);
    const closingFence = closingMatch?.[2] ?? "";
    if (closingFence[0] === openFence.marker && closingFence.length >= openFence.length) {
      openFence = undefined;
    }
  }

  if (!openFence) {
    return [];
  }
  return [{
    line: openFence.line,
    column: openFence.column,
    message: "Unclosed Markdown code fence.",
  }];
}

function scriptKindForExtension(
  extension: string,
  ts: typeof import("typescript"),
): number {
  switch (extension) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.JS;
  }
}

function diagnosticFromBashStderr(stderr: string): SyntaxDiagnostic {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const primary = [...lines].reverse().find((line) => /syntax error/i.test(line)) ?? lines.at(-1) ?? stderr;
  const lineMatch = /\bline\s+(\d+)\b/i.exec(primary) ?? /\bline\s+(\d+)\b/i.exec(stderr);
  const message = primary
    .replace(/^bash:\s*/u, "")
    .replace(/^line\s+\d+:\s*/iu, "");
  return {
    line: lineMatch ? Number(lineMatch[1]) : 1,
    column: 1,
    message: trimDiagnosticMessage(message),
  };
}

async function runChecker(
  command: string,
  args: string[],
  input: string,
): Promise<CheckerResult | undefined> {
  return await new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (result: CheckerResult | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: null,
        stdout,
        stderr,
        timedOut: true,
      });
    }, CHECKER_TIMEOUT_MS);

    child.on("error", () => finish(undefined));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("close", (code) => {
      finish({
        code,
        stdout,
        stderr,
        timedOut: false,
      });
    });

    child.stdin.end(input);
  });
}

function appendCapped(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CHECKER_OUTPUT_BYTES) {
    return current;
  }
  return `${current}${chunk.toString("utf8")}`.slice(0, MAX_CHECKER_OUTPUT_BYTES);
}

function parseJsonLineColumn(message: string): { line: number; column: number } | undefined {
  const match = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(message);
  if (!match) {
    return undefined;
  }
  return {
    line: Number(match[1]),
    column: Number(match[2]),
  };
}

function parseJsonErrorPosition(message: string): number | undefined {
  const match = /\bposition\s+(\d+)\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function positionToLineColumn(content: string, position: number): { line: number; column: number } {
  const target = Math.max(0, Math.min(position, content.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < target; index++) {
    if (content[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function trimDiagnosticMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }
  return `${compact.slice(0, 217).trimEnd()}...`;
}
