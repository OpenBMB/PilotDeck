import { describe, expect, it } from 'vitest';
import { normalizeOfficePreviewService } from './officePreviewStatus';

describe('normalizeOfficePreviewService', () => {
  it('defaults missing and unknown values to disabled', () => {
    expect(normalizeOfficePreviewService(undefined)).toBe('none');
    expect(normalizeOfficePreviewService('unexpected')).toBe('none');
  });

  it('keeps an explicit LibreOffice selection', () => {
    expect(normalizeOfficePreviewService(' LibreOffice ')).toBe('libreoffice');
  });
});
