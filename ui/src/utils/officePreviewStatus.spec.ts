import { describe, expect, it } from 'vitest';
import {
  normalizeOfficePreviewService,
  officePreviewRendererSignature,
  officePreviewRendererSignatureFromConfig,
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

describe('Office preview renderer signatures', () => {
  it('tracks both the selected service and configured LibreOffice path', () => {
    expect(officePreviewRendererSignature('libreoffice', ' /opt/soffice ')).toBe(
      '["libreoffice","/opt/soffice"]',
    );
    expect(officePreviewRendererSignatureFromConfig({
      webui: { officePreview: { service: 'builtin', binaryPath: '' } },
    })).toBe('["builtin",""]');
  });

  it('ignores config payloads without an Office preview section', () => {
    expect(officePreviewRendererSignatureFromConfig({ model: {} })).toBeNull();
  });
});
