import stringWidth from "string-width";
import sliceAnsi from "slice-ansi";

const MAX_LINES = 3;
const PADDING = 10;

/**
 * ANSI-aware truncation to at most MAX_LINES visual lines.
 * ANSI-aware multi-line truncation for TUI display.
 *
 * 4-line special case: if the content has exactly MAX_LINES+1 visual lines,
 * show all 4 rather than truncating to 3 (avoids the absurd "3 lines shown,
 * 1 more" pattern).
 */
export function truncateForDisplay(content: string, terminalWidth: number): string {
  if (!content) return "";

  const trimmed = content.trimEnd();
  if (!trimmed) return "";

  const wrapWidth = Math.max(terminalWidth - PADDING, 10);

  // Pre-truncation: avoid processing megabytes of text
  const charBudget = MAX_LINES * wrapWidth * 4;
  const source = trimmed.length > charBudget ? trimmed.slice(0, charBudget) : trimmed;

  const visualLines = wrapText(source, wrapWidth);
  const totalVisual = visualLines.length;

  if (totalVisual <= MAX_LINES) {
    return trimmed;
  }

  // 4-line special case
  if (totalVisual === MAX_LINES + 1) {
    return trimmed;
  }

  // Truncate to MAX_LINES visual lines
  return visualLines.slice(0, MAX_LINES).join("\n");
}

/**
 * Count how many visual lines `content` would occupy at `terminalWidth`.
 */
export function countVisualLines(content: string, terminalWidth: number): number {
  if (!content) return 0;
  const wrapWidth = Math.max(terminalWidth - PADDING, 10);
  return wrapText(content, wrapWidth).length;
}

/**
 * Split content into visual lines, wrapping long lines based on string-width
 * (ANSI-aware). Each element in the returned array is one visual line.
 */
function wrapText(text: string, width: number): string[] {
  const result: string[] = [];
  const rawLines = text.split("\n");

  for (const rawLine of rawLines) {
    const lineWidth = stringWidth(rawLine);
    if (lineWidth <= width) {
      result.push(rawLine);
      continue;
    }

    // Wrap the line
    let remaining = rawLine;
    while (remaining.length > 0) {
      const w = stringWidth(remaining);
      if (w <= width) {
        result.push(remaining);
        break;
      }

      // Binary search for the right slice point using sliceAnsi
      let lo = 1;
      let hi = remaining.length;
      let best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const slice = sliceAnsi(remaining, 0, mid);
        const sw = stringWidth(slice);
        if (sw <= width) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      result.push(sliceAnsi(remaining, 0, best));
      remaining = sliceAnsi(remaining, best);
    }
  }

  return result;
}
