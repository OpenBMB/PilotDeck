import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  return { ready, release, requested, started, requests: 0, files: [] as string[] };
});
vi.mock('../../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { fileName?: string }) => key === 'loading' ? `Loading ${options?.fileName}` : key,
}) }));
vi.mock('./PdfDocumentPreview', async () => {
  load.requests++;
  load.started();
  await load.ready;
  return { default: ({ fileName, url, onRefresh, onToggleFullscreen }: {
    fileName: string; url: string; onRefresh: () => void; onToggleFullscreen: () => void;
  }) => {
    load.files.push(fileName);
    return <><output>{fileName}: {url}</output><button onClick={onRefresh}>Refresh PDF</button>
      <button onClick={onToggleFullscreen}>Expand PDF</button></>;
  } };
});
afterEach(() => { load.release(); cleanup(); });

it('does not load PDF for other files and delivers the latest file and controls after a delayed PDF import', async () => {
  const module = import('./CodeEditorBinaryFile');
  try {
    expect(await Promise.race([
      module.then(() => 'preview ready'), load.requested.then(() => 'PDF required'),
    ])).toBe('preview ready');
    const { default: Preview } = await module;
    const props = { projectName: 'fixture', isSidebar: true, isFullscreen: false,
      onClose: vi.fn(), onToggleFullscreen: vi.fn(), onToggleExpand: vi.fn(),
      title: 'File preview', message: 'Preview unavailable', headerPrefix: <div>Open files</div> };
    const { rerender } = render(<Preview {...props} file={{ name: 'archive.bin', path: '/fixture/archive.bin' }} />);
    expect(load.requests).toBe(0);
    rerender(<Preview {...props} file={{ name: 'first.pdf', path: '/fixture/first.pdf' }} />);
    await waitFor(() => expect(load.requests).toBe(1));
    expect(screen.getByText('Loading first.pdf')).toBeTruthy();
    expect(screen.getByText('Open files')).toBeTruthy();
    rerender(<Preview {...props} file={{ name: 'second.pdf', path: '/fixture/second.pdf' }} />);
    expect(screen.getByText('Loading second.pdf')).toBeTruthy();
    await act(async () => { load.release(); await load.ready; });
    await screen.findByRole('button', { name: 'Refresh PDF' });
    expect(load.files.every(name => name === 'second.pdf')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('second.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh PDF' }));
    expect(screen.getByRole('status').textContent).toContain('previewRevision=1');
    fireEvent.click(screen.getByRole('button', { name: 'Expand PDF' }));
    expect(props.onToggleExpand).toHaveBeenCalledOnce();
    expect(load.requests).toBe(1);
  } finally {
    load.release();
    await module;
  }
});
