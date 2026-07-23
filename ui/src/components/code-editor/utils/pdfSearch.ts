export type PdfSearchPosition = {
  divIndex: number;
  offset: number;
};

export type PdfSearchMatch = {
  id: string;
  pageNumber: number;
  begin: PdfSearchPosition;
  end: PdfSearchPosition;
};

type NormalizedText = {
  text: string;
  originalOffsets: number[];
};

function normalizeSearchText(value: string): NormalizedText {
  let text = '';
  const originalOffsets: number[] = [];
  let previousWasWhitespace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const isWhitespace = /\s/.test(character);
    if (isWhitespace) {
      if (!previousWasWhitespace && text.length > 0) {
        text += ' ';
        originalOffsets.push(index);
      }
      previousWasWhitespace = true;
      continue;
    }

    previousWasWhitespace = false;
    const normalizedCharacter = character.toLocaleLowerCase();
    text += normalizedCharacter;
    for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
      originalOffsets.push(index);
    }
  }

  return {
    text,
    originalOffsets,
  };
}

function resolveTextPosition(
  textItems: string[],
  offset: number,
  isMatchEnd: boolean,
): PdfSearchPosition {
  let itemStart = 0;
  for (let divIndex = 0; divIndex < textItems.length; divIndex += 1) {
    const itemEnd = itemStart + textItems[divIndex].length;
    const insideItem = isMatchEnd ? offset <= itemEnd : offset < itemEnd;
    if (insideItem || divIndex === textItems.length - 1) {
      return {
        divIndex,
        offset: Math.max(0, Math.min(offset - itemStart, textItems[divIndex].length)),
      };
    }
    itemStart = itemEnd;
  }

  return { divIndex: 0, offset: 0 };
}

export function findPdfSearchMatches(
  textItems: string[],
  query: string,
  pageNumber: number,
): PdfSearchMatch[] {
  if (textItems.length === 0) return [];

  const sourceText = textItems.join('');
  const normalizedSource = normalizeSearchText(sourceText);
  const normalizedQuery = normalizeSearchText(query).text.trim();
  if (!normalizedSource.text || !normalizedQuery) return [];

  const matches: PdfSearchMatch[] = [];
  let searchOffset = 0;
  while (searchOffset < normalizedSource.text.length) {
    const matchIndex = normalizedSource.text.indexOf(normalizedQuery, searchOffset);
    if (matchIndex < 0) break;

    const matchEndIndex = matchIndex + normalizedQuery.length - 1;
    const originalStart = normalizedSource.originalOffsets[matchIndex];
    const originalEnd = normalizedSource.originalOffsets[matchEndIndex] + 1;
    if (Number.isInteger(originalStart) && Number.isInteger(originalEnd)) {
      matches.push({
        id: `page-${pageNumber}-match-${matches.length}`,
        pageNumber,
        begin: resolveTextPosition(textItems, originalStart, false),
        end: resolveTextPosition(textItems, originalEnd, true),
      });
    }
    searchOffset = matchIndex + Math.max(normalizedQuery.length, 1);
  }

  return matches;
}

export function renderPdfSearchHighlights(
  textDivs: HTMLElement[],
  textItems: string[],
  matches: PdfSearchMatch[],
  selectedMatchId: string | null,
): HTMLElement | null {
  let selectedElement: HTMLElement | null = null;

  textDivs.forEach((textDiv, divIndex) => {
    const text = textItems[divIndex] || '';
    const fragments = matches
      .map((match) => {
        if (divIndex < match.begin.divIndex || divIndex > match.end.divIndex) return null;
        const start = divIndex === match.begin.divIndex ? match.begin.offset : 0;
        const end = divIndex === match.end.divIndex ? match.end.offset : text.length;
        return end > start ? { match, start, end } : null;
      })
      .filter((fragment): fragment is NonNullable<typeof fragment> => Boolean(fragment))
      .sort((left, right) => left.start - right.start);

    if (fragments.length === 0) {
      textDiv.replaceChildren(document.createTextNode(text));
      return;
    }

    const content = document.createDocumentFragment();
    let offset = 0;
    fragments.forEach(({ match, start, end }) => {
      if (start > offset) {
        content.append(document.createTextNode(text.slice(offset, start)));
      }

      const highlight = document.createElement('span');
      const selected = match.id === selectedMatchId;
      highlight.className = [
        'highlight',
        'appended',
        'pilotdeck-document-search-highlight',
        selected ? 'selected pilotdeck-document-search-highlight-active' : '',
      ].filter(Boolean).join(' ');
      highlight.dataset.pdfSearchMatchId = match.id;
      if (selected) {
        highlight.setAttribute('aria-current', 'true');
      }
      highlight.append(document.createTextNode(text.slice(start, end)));
      content.append(highlight);
      if (selected && !selectedElement) {
        selectedElement = highlight;
      }
      offset = end;
    });

    if (offset < text.length) {
      content.append(document.createTextNode(text.slice(offset)));
    }
    textDiv.replaceChildren(content);
  });

  return selectedElement;
}
