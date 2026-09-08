import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPathInsideOrEqual,
  normalizePathForComparison,
} from './pathSafety.js';

describe('pathSafety', () => {
  it('treats Windows path containment as case-insensitive through path.relative', () => {
    expect(isPathInsideOrEqual('C:\\Repo', 'c:\\repo\\src\\index.ts', path.win32)).toBe(true);
    expect(isPathInsideOrEqual('C:\\Repo', 'D:\\repo\\src\\index.ts', path.win32)).toBe(false);
  });

  it('does not reject sibling names that start with dot-dot text', () => {
    expect(isPathInsideOrEqual('/repo', '/repo/..data/file.txt', path.posix)).toBe(true);
    expect(isPathInsideOrEqual('/repo', '/repo2/file.txt', path.posix)).toBe(false);
  });

  it('normalizes Windows paths for case-insensitive comparisons', () => {
    expect(normalizePathForComparison('c:\\windows\\System32', path.win32, 'win32'))
      .toBe('c:\\windows\\system32');
    expect(normalizePathForComparison('/Var/Tmp', path.posix, 'linux')).toBe('/Var/Tmp');
  });
});
