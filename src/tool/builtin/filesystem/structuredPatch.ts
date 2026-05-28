export type StructuredPatchLine = {
  type: "context" | "delete" | "add";
  text: string;
};

export type StructuredPatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: StructuredPatchLine[];
};

export function buildStructuredPatch(oldContent: string | null, newContent: string): StructuredPatchHunk[] {
  if (oldContent === null) {
    const addedLines = splitLines(newContent);
    if (addedLines.length === 0) return [];
    return [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: addedLines.length,
      lines: addedLines.map((text) => ({ type: "add" as const, text })),
    }];
  }

  if (oldContent === newContent) {
    return [];
  }

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextLines = 3;
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const oldContextStart = Math.max(0, prefix - contextLines);
  const newContextStart = Math.max(0, prefix - contextLines);
  const oldContextEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const newContextEnd = Math.min(newLines.length, newChangedEnd + contextLines);

  const lines: StructuredPatchLine[] = [];
  for (const text of oldLines.slice(oldContextStart, prefix)) {
    lines.push({ type: "context", text });
  }
  for (const text of oldLines.slice(prefix, oldChangedEnd)) {
    lines.push({ type: "delete", text });
  }
  for (const text of newLines.slice(prefix, newChangedEnd)) {
    lines.push({ type: "add", text });
  }
  for (const text of newLines.slice(newChangedEnd, newContextEnd)) {
    lines.push({ type: "context", text });
  }

  return [{
    oldStart: oldContextStart + 1,
    oldLines: oldContextEnd - oldContextStart,
    newStart: newContextStart + 1,
    newLines: newContextEnd - newContextStart,
    lines,
  }];
}

export function buildUnifiedDiff(filePath: string, oldContent: string | null, newContent: string): string {
  const hunks = buildStructuredPatch(oldContent, newContent);
  if (oldContent !== null && hunks.length === 0) {
    return "";
  }

  const fromPath = oldContent === null ? "/dev/null" : `a/${filePath}`;
  const toPath = `b/${filePath}`;
  const body = hunks.map((hunk) => {
    const header = `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`;
    const lines = hunk.lines.map((line) => `${prefixFor(line.type)}${line.text}`);
    return [header, ...lines].join("\n");
  }).join("\n");
  return `--- ${fromPath}\n+++ ${toPath}${body ? `\n${body}` : ""}`;
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

function prefixFor(type: StructuredPatchLine["type"]): " " | "-" | "+" {
  switch (type) {
    case "context":
      return " ";
    case "delete":
      return "-";
    case "add":
      return "+";
  }
}

function formatRange(start: number, length: number): string {
  if (length === 0) return `${start},0`;
  if (length === 1) return `${start}`;
  return `${start},${length}`;
}
