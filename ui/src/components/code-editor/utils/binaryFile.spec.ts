import { describe, expect, it } from 'vitest';
import { isBinaryFile, isOfficeFile, isSpreadsheetFile } from './binaryFile';

describe('WPS Office file recognition', () => {
  it.each(['proposal.wps', 'budget.et', 'briefing.dps'])(
    'treats %s as an Office binary that uses converted preview',
    (fileName) => {
      expect(isOfficeFile(fileName)).toBe(true);
      expect(isBinaryFile(fileName)).toBe(true);
    },
  );
});

describe('spreadsheet file recognition', () => {
  it.each(['report.xlsx', 'legacy.XLS', 'budget.et', 'sheet.ods'])(
    'treats %s as a spreadsheet preview',
    (fileName) => {
      expect(isSpreadsheetFile(fileName)).toBe(true);
    },
  );

  it.each(['report.docx', 'slides.pptx', 'notes.pdf'])(
    'does not treat %s as a spreadsheet preview',
    (fileName) => {
      expect(isSpreadsheetFile(fileName)).toBe(false);
    },
  );
});
