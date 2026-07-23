import { describe, expect, it } from 'vitest';
import { findPdfSearchMatches, renderPdfSearchHighlights } from './pdfSearch';

describe('findPdfSearchMatches', () => {
  it('finds every occurrence and maps matches across text spans', () => {
    const matches = findPdfSearchMatches(['本人刘', '靖瑶', '确认刘靖瑶'], '刘靖瑶', 2);

    expect(matches).toEqual([
      {
        id: 'page-2-match-0',
        pageNumber: 2,
        begin: { divIndex: 0, offset: 2 },
        end: { divIndex: 1, offset: 2 },
      },
      {
        id: 'page-2-match-1',
        pageNumber: 2,
        begin: { divIndex: 2, offset: 2 },
        end: { divIndex: 2, offset: 5 },
      },
    ]);
  });

  it('matches case-insensitively and collapses whitespace', () => {
    const matches = findPdfSearchMatches(['Pilot', 'Deck  search'], 'pilotdeck search', 1);

    expect(matches).toHaveLength(1);
    expect(matches[0].begin).toEqual({ divIndex: 0, offset: 0 });
    expect(matches[0].end).toEqual({ divIndex: 1, offset: 12 });
  });
});

describe('renderPdfSearchHighlights', () => {
  it('renders all matches and marks the selected result', () => {
    const textDivs = [document.createElement('span'), document.createElement('span')];
    const textItems = ['本人刘', '靖瑶确认'];
    const matches = findPdfSearchMatches(textItems, '刘靖瑶', 1);

    const selected = renderPdfSearchHighlights(textDivs, textItems, matches, matches[0].id);

    expect(textDivs.map((node) => node.textContent).join('')).toBe(textItems.join(''));
    expect(textDivs[0].querySelector('.highlight.selected')?.textContent).toBe('刘');
    expect(textDivs[1].querySelector('.highlight.selected')?.textContent).toBe('靖瑶');
    expect(selected?.dataset.pdfSearchMatchId).toBe(matches[0].id);
    expect(selected?.classList.contains('pilotdeck-document-search-highlight-active')).toBe(true);
    expect(selected?.getAttribute('aria-current')).toBe('true');
  });

  it('keeps every result highlighted while selecting only the active match', () => {
    const textDiv = document.createElement('span');
    const textItems = ['刘靖瑶与刘靖瑶'];
    const matches = findPdfSearchMatches(textItems, '刘靖瑶', 1);

    renderPdfSearchHighlights([textDiv], textItems, matches, matches[1].id);

    expect(textDiv.querySelectorAll('.pilotdeck-document-search-highlight')).toHaveLength(2);
    expect(textDiv.querySelectorAll('.pilotdeck-document-search-highlight-active')).toHaveLength(1);
    expect(
      textDiv.querySelector('.pilotdeck-document-search-highlight-active')?.textContent,
    ).toBe('刘靖瑶');
  });

  it('restores the original text when search is cleared', () => {
    const textDiv = document.createElement('span');
    const textItems = ['searchable'];
    const matches = findPdfSearchMatches(textItems, 'search', 1);
    renderPdfSearchHighlights([textDiv], textItems, matches, matches[0].id);

    renderPdfSearchHighlights([textDiv], textItems, [], null);

    expect(textDiv.textContent).toBe('searchable');
    expect(textDiv.querySelector('.highlight')).toBeNull();
  });
});
