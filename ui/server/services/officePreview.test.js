import { describe, expect, it } from 'vitest';
import { getWindowsLibreOfficeCandidates } from './officePreview.js';

describe('getWindowsLibreOfficeCandidates', () => {
  it('uses the console launcher and honors Windows Program Files locations', () => {
    const candidates = getWindowsLibreOfficeCandidates({
      ProgramW6432: 'D:\\Programs',
      ProgramFiles: 'D:\\Programs',
      'ProgramFiles(x86)': 'D:\\Programs (x86)',
    });

    expect(candidates).toEqual([
      'D:\\Programs\\LibreOffice\\program\\soffice.com',
      'D:\\Programs (x86)\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
    ]);
    expect(candidates.every((candidate) => candidate.endsWith('soffice.com'))).toBe(true);
  });
});
