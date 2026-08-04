import { describe, expect, it } from 'vitest';
import {
  SPREADSHEET_UNIVER_SHEETS_UI_CONFIG,
  SPREADSHEET_UNIVER_UI_CONFIG,
} from './spreadsheetUniverConfig';

describe('spreadsheet Univer focus configuration', () => {
  it('protects surrounding DOM focus while preserving internal sheet focus for wheel scrolling', () => {
    expect(SPREADSHEET_UNIVER_UI_CONFIG.disableAutoFocus).toBe(true);
    expect('disableAutoFocus' in SPREADSHEET_UNIVER_SHEETS_UI_CONFIG).toBe(false);
  });
});
