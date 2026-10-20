import { describe, expect, it } from 'vitest';

import { parseStatusFilePaths } from './git.js';

describe('parseStatusFilePaths', () => {
  it('parses plain porcelain lines', () => {
    const out = parseStatusFilePaths(' M src/a.ts\nA  docs/b.md\n');
    expect(out).toEqual(['src/a.ts', 'docs/b.md']);
  });

  it('strips quotes and decodes git C-quoted paths (#662)', () => {
    // Real git status --porcelain output: spaces and non-ASCII bytes are
    // C-quoted, with octal escapes encoding raw UTF-8 bytes.
    const out = parseStatusFilePaths(
      ' D "na\\303\\257ve.txt"\n?? "hello file.ts"\n',
    );
    expect(out).toEqual(['naïve.txt', 'hello file.ts']);
  });

  it('resolves the rename target from "old -> new"', () => {
    const out = parseStatusFilePaths('R  old.ts -> src/new.ts\n');
    expect(out).toEqual(['src/new.ts']);
  });
});
