import { describe, expect, it } from 'vitest';
import { getFileIconData, getFileVisualCategory } from './fileIcons';

describe('getFileVisualCategory', () => {
  it.each([
    'report.xls',
    'report.xlsx',
    'report.xlsm',
    'report.xlsb',
    'template.xltx',
    'report.ods',
    'report.et',
    'report.csv',
    'report.numbers',
  ])('classifies spreadsheet file %s', (filename) => {
    expect(getFileVisualCategory(filename)).toBe('spreadsheet');
  });

  it.each([
    'Main.java',
    'script.py',
    'native.c',
    'component.tsx',
    'styles.scss',
    'query.sql',
    'Dockerfile',
    'CMakeLists.txt',
  ])('classifies source file %s as code', (filename) => {
    expect(getFileVisualCategory(filename)).toBe('code');
  });

  it('handles uppercase extensions, paths, query strings, and compound extensions', () => {
    expect(getFileVisualCategory('/tmp/REPORT.XLSX?download=1')).toBe('spreadsheet');
    expect(getFileVisualCategory('C:\\tmp\\source.JAVA')).toBe('code');
    expect(getFileVisualCategory('/tmp/backup.tar.gz')).toBe('archive');
  });

  it.each([
    '.env',
    '.env.local',
    '.env.production',
  ])('classifies environment file %s as data', (filename) => {
    expect(getFileVisualCategory(filename)).toBe('data');
  });

  it('keeps image and video in their existing visual categories', () => {
    expect(getFileVisualCategory('photo.webp')).toBe('image');
    expect(getFileVisualCategory('recording.mp4')).toBe('video');
    expect(getFileIconData('photo.webp').icon).toBeDefined();
    expect(getFileIconData('recording.mp4').icon).toBeDefined();
  });

  it('uses MIME type when a usable extension is unavailable', () => {
    expect(getFileVisualCategory(
      'uploaded-file',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )).toBe('spreadsheet');
    expect(getFileVisualCategory('uploaded-file', 'image/png')).toBe('image');
  });

  it('falls back to the document SVG for unknown file types', () => {
    expect(getFileVisualCategory('notes.unknown-format')).toBe('document');
    expect(getFileVisualCategory('extensionless')).toBe('document');
    expect(getFileIconData('notes.unknown-format').asset).toBe(
      getFileIconData('notes.docx').asset,
    );
  });
});
