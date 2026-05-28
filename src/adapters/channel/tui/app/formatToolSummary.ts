/**
 * Content-aware one-line summary for tool outputs.
 * Detects test results, compilation errors, and falls back to line count.
 */
export function formatToolSummary(
  toolName: string,
  argsHint: string | undefined,
  lineCount: number,
  _bytes: number,
  ok: boolean,
  previewText: string,
): string {
  if (!ok) {
    const firstLine = previewText.split("\n")[0]?.slice(0, 80) ?? "unknown error";
    return `${toolName}: \u2717 ${firstLine}`;
  }

  const label = argsHint ? `${toolName}: ${argsHint}` : toolName;

  if (toolName === "bash") {
    const text = previewText;

    // Test results: "N passing/passed/ok"
    const passing = text.match(/(\d+)\s*(?:passing|passed|ok)/i);
    if (passing) {
      const failing = text.match(/(\d+)\s*(?:failing|failed)/i);
      return failing
        ? `${label} \u2192 \u2717 ${passing[1]} passed, ${failing[1]} failed`
        : `${label} \u2192 \u2713 ${passing[1]} passed`;
    }

    // Compilation / runtime errors
    if (/error\s*TS\d+|SyntaxError|TypeError|ReferenceError/i.test(text)) {
      const errCount = (text.match(/error/gi) ?? []).length;
      return `${label} \u2192 \u2717 ${errCount} error${errCount > 1 ? "s" : ""}`;
    }
  }

  return `${label} \u2192 ${lineCount} lines`;
}
