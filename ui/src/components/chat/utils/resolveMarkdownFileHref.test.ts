import { describe, expect, it } from 'vitest';
import { resolveMarkdownFileHref } from './resolveMarkdownFileHref';

const ORIGIN = 'http://localhost:5173';

describe('resolveMarkdownFileHref', () => {
  it('resolves misrouted /session/<file.md> URLs on the same origin', () => {
    expect(
      resolveMarkdownFileHref(
        'http://localhost:5173/session/%E5%A4%A7%E6%A8%A1%E5%9E%8B%E8%B0%83%E7%A0%94%E6%8A%A5%E5%91%8A.md',
        { origin: ORIGIN },
      ),
    ).toBe('大模型调研报告.md');
    expect(
      resolveMarkdownFileHref('/session/%E5%A4%A7%E6%A8%A1%E5%9E%8B%E8%B0%83%E7%A0%94%E6%8A%A5%E5%91%8A.md'),
    ).toBe('大模型调研报告.md');
  });

  it('resolves relative markdown paths', () => {
    expect(resolveMarkdownFileHref('docs/report.md')).toBe('docs/report.md');
    expect(resolveMarkdownFileHref('./notes.md')).toBe('notes.md');
    expect(resolveMarkdownFileHref('/docs/report.md')).toBe('docs/report.md');
  });

  it('ignores external URLs and non-file session paths', () => {
    expect(resolveMarkdownFileHref('https://example.com/report.md', { origin: ORIGIN })).toBeNull();
    expect(resolveMarkdownFileHref('http://localhost:5173/session/abc-123-def', { origin: ORIGIN })).toBeNull();
    expect(resolveMarkdownFileHref('#section')).toBeNull();
  });

  it('resolves paths relative to the current markdown file', () => {
    expect(resolveMarkdownFileHref('../notes.md', { baseFilePath: 'docs/report.md' })).toBe('notes.md');
    expect(resolveMarkdownFileHref('other.md', { baseFilePath: 'docs/report.md' })).toBe('docs/other.md');
  });
});
