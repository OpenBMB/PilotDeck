// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

const artifact = {
  name: '今日热点-2026-08-0803.docx',
  path: 'reports/今日热点-2026-08-0803.docx',
};

describe('Markdown artifact file text', () => {
  it('keeps a generated Unicode filename as plain text', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        已完成今日热点总结并生成文件： 今日热点-2026-08-0803.docx
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/今日热点-2026-08-0803\.docx/u)).toBeTruthy();
  });

  it('turns a valid Markdown link for the card artifact back into plain text', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {`[打开 Word 文件：${artifact.name}](${artifact.name})`}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`打开 Word 文件：${artifact.name}`)).toBeTruthy();
  });

  it('cleans malformed sandbox links with spaces without exposing the target', () => {
    const spacedArtifact = {
      name: '优秀共产党员推荐审批表-补充 DSMDEM.docx',
      path: 'deliverables/优秀共产党员推荐审批表-补充 DSMDEM.docx',
    };
    render(
      <Markdown artifactFiles={[spacedArtifact]} onFileOpen={vi.fn()}>
        {`[下载：${spacedArtifact.name}](sandbox:/mnt/data/${spacedArtifact.name})`}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`下载：${spacedArtifact.name}`)).toBeTruthy();
    expect(screen.queryByText(/sandbox:\/\/mnt\/data/u)).toBeNull();
  });

  it('keeps external web links clickable', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {'查看 [官方网站](https://example.com/report)。'}
      </Markdown>,
    );

    const link = screen.getByRole('link', { name: '官方网站' });
    expect(link.getAttribute('href')).toBe('https://example.com/report');
  });

  it('does not rewrite artifact-looking text inside code', () => {
    render(
      <Markdown artifactFiles={[artifact]} onFileOpen={vi.fn()}>
        {`\`[${artifact.name}](${artifact.name})\``}
      </Markdown>,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(`[${artifact.name}](${artifact.name})`)).toBeTruthy();
  });
});
