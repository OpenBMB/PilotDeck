// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findDomTextMatches } from './useDomFileSearch';

describe('findDomTextMatches', () => {
  it('finds visible Chinese and English text nodes', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>PilotDeck 文件搜索</p><p>pilotdeck</p>';

    expect(findDomTextMatches(root, 'pilotdeck')).toHaveLength(2);
    expect(findDomTextMatches(root, '文件')).toHaveLength(1);
  });

  it('ignores scripts, styles, and search controls', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<p>visible needle</p>',
      '<script>const needle = true</script>',
      '<style>.needle { color: red; }</style>',
      '<div data-file-search-exclude>needle</div>',
    ].join('');

    expect(findDomTextMatches(root, 'needle')).toHaveLength(1);
  });

  it('creates valid ranges when Unicode case folding expands a character', () => {
    const root = document.createElement('div');
    root.textContent = 'İstanbul';

    const matches = findDomTextMatches(root, 'İ');

    expect(matches).toHaveLength(1);
    expect(matches[0].range.toString()).toBe('İ');
  });
});
