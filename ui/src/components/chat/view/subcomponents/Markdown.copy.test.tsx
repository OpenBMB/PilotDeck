// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import { copyHtmlToClipboard, copyTextToClipboard } from '../../../../utils/clipboard';

vi.mock('../../../../utils/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
  copyHtmlToClipboard: vi.fn(async () => true),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }),
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const latex = String.raw`Section~\ref{sec:memory_construction}
\textbf{Title}
\newcommand{\name}{value}
C:\research\notes\table.tex
const s = "\r\n\t";
&lt;tag&gt; &amp; &#39;`;
const message = (content: string) => normalizedToChatMessages([{
  id: 'assistant-1', sessionId: 'session-1', timestamp: '2026-09-09T00:00:00Z',
  provider: 'pilotdeck', kind: 'text', role: 'assistant', content,
}])[0].content;

describe('chat Markdown fidelity and block copying', () => {
  it('keeps adjacent LaTeX blocks separate through message conversion, rendering and copying', async () => {
    const original = ['```latex', latex, '```', '**修改后**', '```latex', 'replacement', '```'].join('\n');
    const { container } = render(<Markdown>{message(original)}</Markdown>);
    expect(container.querySelectorAll('pre')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('修改后');
    expect(container.querySelector('pre code')?.textContent).toBe(latex + '\n');
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy code' })[0]);
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(latex));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('preserves code indentation, tabs, trailing spaces and blank lines', async () => {
    const code = '\tfirst  \n    second\n\n';
    render(<Markdown>{'```\n' + code + '\n```'}</Markdown>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(code));
  });

  it('adds controls to tilde and indented blocks, but not inline code', () => {
    const { container } = render(<Markdown>{'~~~latex\n' + latex + '\n~~~\n\n    indented\n\n`inline`'}</Markdown>);
    expect(container.querySelectorAll('pre')).toHaveLength(2);
    expect(container.querySelectorAll('pre button')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2);
  });

  it('copies the latest streaming content and keeps the same block when the stream completes', async () => {
    const prefix = '```latex\nSection~\\r';
    const { rerender, container } = render(<Markdown isStreaming>{message(prefix)}</Markdown>);
    const button = screen.getByRole('button', { name: 'Copy code' });
    const completed = '```latex\nSection~\\ref{sec:test}\n```';
    rerender(<Markdown isStreaming>{message(completed)}</Markdown>);
    expect(screen.getByRole('button', { name: 'Copy code' })).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenLastCalledWith(String.raw`Section~\ref{sec:test}`));
    rerender(<Markdown>{message(completed)}</Markdown>);
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
  });

  it('copies just the selected table as HTML/TSV or original Markdown', async () => {
    const table = '| Name | Value |\n| :--- | ---: |\n| **Alpha** | `a\\nb` |\n| Beta | 2 |';
    render(<Markdown>{'Intro\n\n' + table + '\n\nOther text\n\n| X |\n| - |\n| Y |'}</Markdown>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy table' })[0]);
    await waitFor(() => expect(copyHtmlToClipboard).toHaveBeenCalledOnce());
    const [html, text] = vi.mocked(copyHtmlToClipboard).mock.calls[0];
    expect(text).toBe('Name\tValue\nAlpha\ta\\nb\nBeta\t2');
    expect(html).toContain('<table');
    expect(html).toContain('<strong>Alpha</strong>');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Intro');
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy table as Markdown' })[0]);
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(table));
  });

  it('copies a formula in a table once, without duplicated KaTeX accessibility text', async () => {
    render(<Markdown>{'| Equation |\n| --- |\n| $x^2$ |'}</Markdown>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    await waitFor(() => expect(copyHtmlToClipboard).toHaveBeenCalledOnce());
    expect(vi.mocked(copyHtmlToClipboard).mock.calls[0][1]).toBe('Equation\nx^2');
  });

  it('copies a table inside a blockquote as standalone Markdown', async () => {
    render(<Markdown>{'> | Name | Value |\n> | --- | --- |\n> | Alpha | 1 |'}</Markdown>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy table as Markdown' }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith('| Name | Value |\n| --- | --- |\n| Alpha | 1 |'));
  });

  it('reports a failed copy without claiming success and allows retry', async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(false);
    render(<Markdown>{'```\nhello\n```'}</Markdown>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy failed. Try again.' }));
    await screen.findByRole('button', { name: 'Copied' });
  });
});


it('shows language labels and preserves wrapping choice while a code block streams', () => {
  const view = render(<Markdown isStreaming>{'```python\nprint(1)'}</Markdown>);
  expect(screen.getByText('python')).toBeTruthy();
  const wrap = screen.getByRole('button', { name: 'Wrap code' });
  expect(wrap.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(wrap);
  view.rerender(<Markdown>{'```python\nprint(123)\n```'}</Markdown>);
  expect(screen.getByRole('button', { name: 'Wrap code' })).toBe(wrap);
  expect(wrap.getAttribute('aria-pressed')).toBe('false');
  expect(view.container.querySelector('.markdown-code-block')?.getAttribute('data-wrap')).toBe('false');
  expect(view.container.querySelector('pre code')?.textContent).toBe('print(123)\n');
});

it('labels unlabeled blocks as plain text without adding a toolbar to inline code', () => {
  const { container } = render(<Markdown>{'```\nplain\n```\n\n`inline`'}</Markdown>);
  expect(screen.getByText('Plain text')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(1);
  expect(container.querySelector('code:not(pre code)')?.textContent).toBe('inline');
});
