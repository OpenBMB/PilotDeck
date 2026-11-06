// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { ThemeProvider, useTheme } from '../../../../contexts/ThemeContext';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { Markdown } from './Markdown';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), detectType: vi.fn(), render: vi.fn() } }));
vi.mock('../../../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }),
}));

const source = 'flowchart LR\n  A[用户] --> B[结果]';
const fenced = (value = source) => `\`\`\`mermaid\n${value}\n\`\`\``;
function ThemeToggle() {
  const { toggleDarkMode } = useTheme();
  return <button onClick={toggleDarkMode}>Toggle theme</button>;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem('themeMode', 'light');
  vi.mocked(copyTextToClipboard).mockResolvedValue(true);
  vi.mocked(mermaid.detectType).mockReturnValue('flowchart-v2');
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg><text>Rendered diagram</text></svg>', diagramType: 'flowchart' });
});
afterEach(() => { cleanup(); document.documentElement.classList.remove('dark'); });

describe('Mermaid chat code blocks', () => {
  it('renders completed diagrams, switches views and copies the unchanged source', async () => {
    const view = render(<Markdown>{fenced()}</Markdown>, { wrapper: ThemeProvider });
    await screen.findByRole('img', { name: 'Mermaid diagram' });
    expect(view.container.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }));
    expect(view.container.querySelector('pre code')?.textContent).toBe(source + '\n');
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(source));
    fireEvent.click(screen.getByRole('button', { name: 'Show diagram' }));
    expect(screen.getByRole('img')).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('keeps source during streaming and renders only after completion without replacing the copy control', async () => {
    const view = render(<Markdown isStreaming>{'```mermaid\nflowchart LR\n A['}</Markdown>, { wrapper: ThemeProvider });
    const copy = screen.getByRole('button', { name: 'Copy code' });
    view.rerender(<Markdown isStreaming>{fenced()}</Markdown>);
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(view.container.querySelector('pre code')?.textContent).toBe(source + '\n');
    view.rerender(<Markdown>{fenced()}</Markdown>);
    await screen.findByRole('img');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBe(copy);
  });

  it('preserves invalid or interrupted output and copying when rendering fails', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Syntax error'));
    const invalid = 'flowchart LR\n A[';
    const view = render(<Markdown>{'```mermaid\n' + invalid}</Markdown>, { wrapper: ThemeProvider });
    await screen.findByText('Unable to render this diagram. The source is shown below.');
    expect(view.container.querySelector('pre code')?.textContent).toBe(invalid + '\n');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(invalid));
  });

  it('ignores stale results after the message changes', async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    vi.mocked(mermaid.render)
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = svg => resolve({ svg, diagramType: 'flowchart' }); }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = svg => resolve({ svg, diagramType: 'flowchart' }); }));
    const view = render(<Markdown>{fenced('flowchart LR\n A[Old]')}</Markdown>, { wrapper: ThemeProvider });
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    view.rerender(<Markdown>{fenced('flowchart LR\n A[New]')}</Markdown>);
    await act(async () => { finishOld('<svg><text>Old diagram</text></svg>'); });
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Old diagram')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    await act(async () => { finishNew('<svg><text>Rendered diagram</text></svg>'); });
    await screen.findByText('Rendered diagram');
  });

  it('renders separate blocks and updates them when the application theme changes', async () => {
    render(<><Markdown>{fenced() + '\n\n' + fenced('sequenceDiagram\n A->>B: Hello')}</Markdown><ThemeToggle /></>, { wrapper: ThemeProvider });
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), source, expect.any(HTMLElement));
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
    await waitFor(() => expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
    await waitFor(() => expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' })));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));
  });

  it('leaves ordinary code unchanged', () => {
    render(<Markdown>{'```js\nconsole.log(1)\n```'}</Markdown>, { wrapper: ThemeProvider });
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Show source' })).toBeNull();
  });
});
