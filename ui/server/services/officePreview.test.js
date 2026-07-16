import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLibreOfficeConversionWorkspace,
  getWindowsLibreOfficeCandidates,
} from './officePreview.js';

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

describe('createLibreOfficeConversionWorkspace', () => {
  it('keeps the LibreOffice profile outside the hashed conversion directory', async () => {
    const testRoot = await mkdtemp(path.join(tmpdir(), 'pilotdeck-office-preview-test-'));
    const cacheDir = path.join(testRoot, 'a'.repeat(64));
    await mkdir(cacheDir);

    let workspace;
    try {
      workspace = await createLibreOfficeConversionWorkspace(cacheDir);

      expect(path.dirname(workspace.tempDir)).toBe(cacheDir);
      expect(path.dirname(workspace.profileDir)).toBe(path.resolve(tmpdir()));
      expect(workspace.profileDir.startsWith(workspace.tempDir)).toBe(false);
      expect(workspace.profileDir.length).toBeLessThan(workspace.tempDir.length);
    } finally {
      await Promise.all([
        workspace?.profileDir
          ? rm(workspace.profileDir, { recursive: true, force: true })
          : Promise.resolve(),
        rm(testRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
