const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
const LEFT_DOUBLE_CURLY_QUOTE = "\u201C";
const RIGHT_DOUBLE_CURLY_QUOTE = "\u201D";

/**
 * Normalize curly/smart quotes to their ASCII counterparts.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * Strip trailing whitespace from every line, preserving line endings.
 */
export function stripTrailingWhitespace(str: string): string {
  const parts = str.split(/(\r\n|\n|\r)/);
  let result = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    result += i % 2 === 0 ? part.replace(/\s+$/, "") : part;
  }
  return result;
}

/**
 * Two-level string matching:
 * 1. Exact match — returns `searchString` as-is.
 * 2. Quote-normalized match — normalizes both sides and maps the index back
 *    to the original file content.
 *
 * Returns the *actual* substring from `fileContent` that corresponds to
 * `searchString`, or `null` when nothing matches.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const idx = normalizedFile.indexOf(normalizedSearch);
  if (idx !== -1) {
    return fileContent.substring(idx, idx + searchString.length);
  }

  return null;
}

/**
 * Pre-process old_string and new_string before applying an edit.
 * - Strips trailing whitespace from new_string (except for markdown files).
 */
export function normalizeEditInput(
  absolutePath: string,
  oldString: string,
  newString: string,
): { oldString: string; newString: string } {
  const isMarkdown = /\.(md|mdx)$/i.test(absolutePath);
  return {
    oldString,
    newString: isMarkdown ? newString : stripTrailingWhitespace(newString),
  };
}
