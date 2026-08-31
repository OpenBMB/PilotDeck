import { describe, expect, it } from 'vitest';
import {
  canonicalizeWorkspaceFilePath,
  getWorkspaceFileIdentity,
  getWorkspaceRelativePath,
  hasWorkspaceFileMention,
  insertWorkspaceFileMention,
  isWorkspacePathAtOrBelow,
} from './workspaceFileMention';

describe('workspace file identity', () => {
  it('canonicalizes absolute and relative paths inside the same workspace', () => {
    expect(canonicalizeWorkspaceFilePath(
      '/workspace/project-a/docs/report.xlsx',
      '/workspace/project-a',
    )).toBe('docs/report.xlsx');
    expect(canonicalizeWorkspaceFilePath(
      './docs/report.xlsx',
      '/workspace/project-a',
    )).toBe('docs/report.xlsx');
  });

  it('normalizes slash and case differences for a Windows workspace identity', () => {
    expect(getWorkspaceFileIdentity(
      'C:\\Work\\PilotDeck\\Docs\\Report.xlsx',
      'c:\\work\\pilotdeck',
    )).toBe(getWorkspaceFileIdentity(
      'docs/report.xlsx',
      'c:\\work\\pilotdeck',
    ));
  });

  it('normalizes Windows file URL pathnames and UNC path casing', () => {
    expect(getWorkspaceFileIdentity(
      '/C:/Work/PilotDeck/Docs/Report.xlsx',
      'c:\\work\\pilotdeck',
    )).toBe(getWorkspaceFileIdentity(
      'docs/report.xlsx',
      'c:\\work\\pilotdeck',
    ));
    expect(getWorkspaceFileIdentity(
      '\\\\server\\share\\pilotdeck\\Docs\\Report.xlsx',
      '\\\\Server\\Share\\PilotDeck',
    )).toBe(getWorkspaceFileIdentity(
      'docs/report.xlsx',
      '\\\\Server\\Share\\PilotDeck',
    ));
  });

  it('keeps files with the same basename in different folders distinct', () => {
    expect(getWorkspaceFileIdentity('one/report.xlsx', '/workspace/project-a')).not.toBe(
      getWorkspaceFileIdentity('two/report.xlsx', '/workspace/project-a'),
    );
  });

  it('compares Windows paths and descendants case-insensitively', () => {
    const workspaceRoot = 'C:\\Work\\PilotDeck';
    expect(isWorkspacePathAtOrBelow(
      'docs/reports/Annual.xlsx',
      'Docs/Reports',
      workspaceRoot,
    )).toBe(true);
    expect(isWorkspacePathAtOrBelow(
      'docs/reports-archive/Annual.xlsx',
      'Docs/Reports',
      workspaceRoot,
    )).toBe(false);
  });
});

describe('getWorkspaceRelativePath', () => {
  it('returns a workspace-relative path for POSIX paths', () => {
    expect(getWorkspaceRelativePath(
      '/workspace/contracts/采购合同.docx',
      '/workspace',
    )).toBe('contracts/采购合同.docx');
  });

  it('normalizes Windows paths and compares drive paths case-insensitively', () => {
    expect(getWorkspaceRelativePath(
      'C:\\Work\\PilotDeck\\docs\\report.docx',
      'c:\\work\\pilotdeck',
    )).toBe('docs/report.docx');
    expect(getWorkspaceRelativePath(
      '/C:/Work/PilotDeck/docs/report.docx',
      'c:\\work\\pilotdeck',
    )).toBe('docs/report.docx');
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(getWorkspaceRelativePath('/other/report.docx', '/workspace')).toBeNull();
  });

  it('supports a filesystem-root workspace without losing the file name', () => {
    expect(getWorkspaceRelativePath('/report.docx', '/')).toBe('report.docx');
  });

  it('rejects relative paths that escape the workspace', () => {
    expect(getWorkspaceRelativePath('../report.docx', '/workspace')).toBeNull();
  });
});

describe('insertWorkspaceFileMention', () => {
  it('inserts a mention into an empty composer', () => {
    expect(insertWorkspaceFileMention('', 'docs/report.docx', 0)).toEqual({
      input: 'docs/report.docx ',
      cursorPosition: 17,
      alreadyPresent: false,
    });
  });

  it('preserves readable spacing when inserting at the last cursor position', () => {
    expect(insertWorkspaceFileMention('Review please', 'docs/report.docx', 7)).toEqual({
      input: 'Review docs/report.docx please',
      cursorPosition: 24,
      alreadyPresent: false,
    });
  });

  it('does not insert the same path twice', () => {
    expect(insertWorkspaceFileMention('Review docs/report.docx please', 'docs/report.docx', 30)).toEqual({
      input: 'Review docs/report.docx please',
      cursorPosition: 30,
      alreadyPresent: true,
    });
  });

  it('does not mistake a longer path with the same prefix for an existing mention', () => {
    expect(insertWorkspaceFileMention('docs/report.docx.bak', 'docs/report.docx', 20)).toEqual({
      input: 'docs/report.docx.bak docs/report.docx ',
      cursorPosition: 38,
      alreadyPresent: false,
    });
  });

  it('matches mentions only at explicit whitespace boundaries', () => {
    expect(hasWorkspaceFileMention('Review docs/report.docx please', 'docs/report.docx')).toBe(true);
    expect(hasWorkspaceFileMention('docs/report.docx.bak', 'docs/report.docx')).toBe(false);
    expect(hasWorkspaceFileMention('archive/docs/report.docx', 'docs/report.docx')).toBe(false);
  });
});
