import { describe, expect, it } from 'vitest';

import { stripDiffHeaders } from './git.js';

describe('stripDiffHeaders', () => {
  it('strips diff headers but keeps hunk content', () => {
    const diff = [
      'diff --git a/doc.md b/doc.md',
      'index 7753021..cfe7321 100644',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-old',
      '+new',
    ].join('\n');

    expect(stripDiffHeaders(diff)).toBe(
      ['@@ -1,3 +1,3 @@', ' unchanged', '-old', '+new'].join('\n'),
    );
  });

  it('keeps hunk content lines that start with --- or +++ (#661)', () => {
    // Deleting YAML frontmatter delimiters: removed lines are "-" + "---" and
    // content can also legitimately start with "--" / "++". Before the fix the
    // prefix filter ran on every line and dropped those deletions.
    const diff = [
      'diff --git a/doc.md b/doc.md',
      'index 7753021..cfe7321 100644',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,6 +1,3 @@',
      '---',
      '-title: test',
      '---',
      ' content',
      ' -- not a header',
      ' ++ not either',
    ].join('\n');

    expect(stripDiffHeaders(diff)).toBe(
      [
        '@@ -1,6 +1,3 @@',
        '---',
        '-title: test',
        '---',
        ' content',
        ' -- not a header',
        ' ++ not either',
      ].join('\n'),
    );
  });

  it('handles empty input', () => {
    expect(stripDiffHeaders('')).toBe('');
    expect(stripDiffHeaders(undefined)).toBe('');
  });
});
