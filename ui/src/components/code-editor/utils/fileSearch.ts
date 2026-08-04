export type TextSearchMatch = {
  from: number;
  to: number;
};

type FoldedText = {
  value: string;
  offsetSegments: FoldedOffsetSegment[];
};

type FoldedOffsetSegment = {
  foldedStart: number;
  foldedEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

const ASCII_TEXT_PATTERN = /^[\x00-\x7f]*$/u;

function foldTextWithSourceOffsets(text: string): FoldedText {
  // The overwhelming majority of source files are ASCII. Native lowercasing
  // keeps offsets identical and avoids per-character objects or arrays while
  // the user types into the search field.
  if (ASCII_TEXT_PATTERN.test(text)) {
    return { value: text.toLowerCase(), offsetSegments: [] };
  }

  let value = '';
  const offsetSegments: FoldedOffsetSegment[] = [];

  for (let sourceIndex = 0; sourceIndex < text.length;) {
    const codePoint = text.codePointAt(sourceIndex);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const sourceEnd = sourceIndex + sourceCharacter.length;
    // Upper-then-lower provides a context-independent case fold (for example,
    // it treats the two Greek sigma forms alike). Record only length-changing
    // segments so expansions such as `İ` and `ß` map back to the source
    // without allocating two boxed-number arrays for the entire file.
    const foldedCharacter = sourceCharacter.toUpperCase().toLowerCase();
    const foldedStart = value.length;
    value += foldedCharacter;
    const foldedEnd = value.length;
    if (foldedCharacter.length !== sourceCharacter.length) {
      offsetSegments.push({
        foldedStart,
        foldedEnd,
        sourceStart: sourceIndex,
        sourceEnd,
      });
    }
    sourceIndex = sourceEnd;
  }

  return { value, offsetSegments };
}

function sourceRangeForFoldedIndex(
  foldedText: FoldedText,
  foldedIndex: number,
): TextSearchMatch {
  let low = 0;
  let high = foldedText.offsetSegments.length - 1;
  let previousSegmentIndex = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = foldedText.offsetSegments[middle];
    if (segment.foldedStart <= foldedIndex) {
      previousSegmentIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previousSegment = previousSegmentIndex >= 0
    ? foldedText.offsetSegments[previousSegmentIndex]
    : undefined;
  if (previousSegment && foldedIndex < previousSegment.foldedEnd) {
    return {
      from: previousSegment.sourceStart,
      to: previousSegment.sourceEnd,
    };
  }

  const accumulatedOffset = previousSegment
    ? previousSegment.foldedEnd - previousSegment.sourceEnd
    : 0;
  const sourceIndex = foldedIndex - accumulatedOffset;
  return { from: sourceIndex, to: sourceIndex + 1 };
}

export function findTextSearchMatches(text: string, query: string): TextSearchMatch[] {
  const normalizedQuery = foldTextWithSourceOffsets(query.trim()).value;
  if (!normalizedQuery) return [];

  const foldedText = foldTextWithSourceOffsets(text);
  const matches: TextSearchMatch[] = [];
  let searchOffset = 0;

  while (searchOffset <= foldedText.value.length - normalizedQuery.length) {
    const index = foldedText.value.indexOf(normalizedQuery, searchOffset);
    if (index < 0) break;
    const lastFoldedIndex = index + normalizedQuery.length - 1;
    const firstSourceRange = sourceRangeForFoldedIndex(foldedText, index);
    const lastSourceRange = sourceRangeForFoldedIndex(foldedText, lastFoldedIndex);
    const match = {
      from: firstSourceRange.from,
      to: lastSourceRange.to,
    };
    const previous = matches[matches.length - 1];
    if (!previous || previous.from !== match.from || previous.to !== match.to) {
      matches.push(match);
    }
    searchOffset = index + Math.max(1, normalizedQuery.length);
  }

  return matches;
}
