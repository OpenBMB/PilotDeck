import { describe, expect, it } from 'vitest';
import { findTextSearchMatches } from './fileSearch';

describe('findTextSearchMatches', () => {
  it('finds case-insensitive text and preserves source offsets', () => {
    expect(findTextSearchMatches('PilotDeck pilotdeck', 'PILOT')).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 15 },
    ]);
  });

  it('finds Chinese text and ignores an empty query', () => {
    expect(findTextSearchMatches('搜索所有文件，文件搜索', '文件')).toEqual([
      { from: 4, to: 6 },
      { from: 7, to: 9 },
    ]);
    expect(findTextSearchMatches('searchable', '   ')).toEqual([]);
  });

  it('preserves source offsets when case folding changes string length', () => {
    expect(findTextSearchMatches('İstanbul', 'İ')).toEqual([
      { from: 0, to: 1 },
    ]);
    expect(findTextSearchMatches('İstanbul', 'i')).toEqual([
      { from: 0, to: 1 },
    ]);
    expect(findTextSearchMatches('Straße', 'SS')).toEqual([
      { from: 4, to: 5 },
    ]);
  });

  it('keeps sparse source offsets correct after long ordinary-text prefixes', () => {
    const prefix = 'a'.repeat(250_000);
    const text = `${prefix}İstanbul and Straße`;

    expect(findTextSearchMatches(text, 'i̇stanbul')).toEqual([
      { from: prefix.length, to: prefix.length + 'İstanbul'.length },
    ]);
    expect(findTextSearchMatches(text, 'strasse')).toEqual([
      {
        from: prefix.length + 'İstanbul and '.length,
        to: text.length,
      },
    ]);
  });
});
