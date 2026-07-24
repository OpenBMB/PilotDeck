import { describe, expect, it } from 'vitest';
import { getPdfNavigationMode } from './documentPreview';

describe('getPdfNavigationMode', () => {
  it.each(['report.pdf', 'brief.doc', 'brief.docx', 'brief.wps', 'brief.odt'])(
    'uses page navigation for %s',
    (fileName) => {
      expect(getPdfNavigationMode(fileName)).toBe('pages');
    },
  );

  it.each(['deck.ppt', 'deck.pptx', 'deck.dps', 'deck.odp'])(
    'uses slide navigation for %s',
    (fileName) => {
      expect(getPdfNavigationMode(fileName)).toBe('slides');
    },
  );

  it.each(['workbook.xlsx', 'notes.md', 'image.png'])(
    'does not use document navigation for %s',
    (fileName) => {
      expect(getPdfNavigationMode(fileName)).toBe('none');
    },
  );
});
