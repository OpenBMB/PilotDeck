import { describe, expect, it } from 'vitest';
import { linkifyFilePathsOutsideCode } from './linkifyFilePathsOutsideCode';

describe('linkifyFilePathsOutsideCode', () => {
  it('linkifies prose file paths', () => {
    expect(linkifyFilePathsOutsideCode('See docs/report.pdf for details.'))
      .toBe('See [docs/report.pdf](docs/report.pdf) for details.');
  });

  it('does not linkify inline code', () => {
    expect(linkifyFilePathsOutsideCode('Run `cat docs/report.pdf` first.'))
      .toBe('Run `cat docs/report.pdf` first.');
  });

  it('does not linkify fenced code blocks', () => {
    const markdown = ['```ts', "import './foo.ts';", '```', 'Then open docs/report.pdf.'].join('\n');
    expect(linkifyFilePathsOutsideCode(markdown))
      .toBe(['```ts', "import './foo.ts';", '```', 'Then open [docs/report.pdf](docs/report.pdf).'].join('\n'));
  });
});
