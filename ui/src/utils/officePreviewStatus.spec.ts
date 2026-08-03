import { describe, expect, it } from 'vitest';
import {
  normalizeOfficePreviewService,
} from './officePreviewStatus';

describe('normalizeOfficePreviewService', () => {
  it('defaults missing and unknown values to built-in preview', () => {
    expect(normalizeOfficePreviewService(undefined)).toBe('builtin');
    expect(normalizeOfficePreviewService('unexpected')).toBe('builtin');
  });

  it('keeps an explicit LibreOffice selection', () => {
    expect(normalizeOfficePreviewService(' LibreOffice ')).toBe('libreoffice');
  });
});
