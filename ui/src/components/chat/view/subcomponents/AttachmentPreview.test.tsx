// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentPreviewKind } from '../../utils/attachmentPreviewKind';
import ComposerAttachments from './ComposerAttachments';
import AttachmentPreview from './AttachmentPreview';
import ImageLightbox from './ImageLightbox';

vi.mock('../../utils/rasterizeAttachmentImage', () => ({ rasterizeAttachmentImage: vi.fn(async () => new Blob(['pixels'], { type: 'image/png' })) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: any) => key === 'attachmentPreview.open' ? `Preview ${options.name}` : key }) }));
let created: string[];
beforeEach(() => {
  created = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => { const url = `blob:test-${created.length}`; created.push(url); return url; }), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const images = () => ['a', 'b', 'c'].map(data => new File([data], 'image.png', { type: 'image/png' }));

describe('draft attachment preview', () => {
  it('keeps an open sent-image lightbox safe when history replaces a shorter image list', () => {
    const list = ['a', 'b', 'c'].map(data => ({ name: data, data: `data:image/png;base64,${data}` }));
    const view = render(<ImageLightbox images={list} startIndex={2} onClose={vi.fn()} />);
    view.rerender(<ImageLightbox images={list.slice(0, 1)} startIndex={2} onClose={vi.fn()} />);
    expect(screen.getByRole('img').getAttribute('alt')).toBe('a');
  });
  it('opens the selected same-name image, cycles with buttons/keys, traps focus and restores the opener', async () => {
    const files = images();
    const onRemove = vi.fn();
    const view = render(<ComposerAttachments files={files} uploading={new Map()} errors={new Map()} onRemove={onRemove} onRetry={vi.fn()} />);
    const opener = screen.getAllByRole('button', { name: 'Preview image.png' })[1];
    opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 \/ 3/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'attachmentPreview.next' }));
    expect(within(dialog).getByText(/3 \/ 3/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(within(dialog).getByText(/1 \/ 3/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(within(dialog).getByText(/3 \/ 3/)).toBeTruthy();
    const last = within(dialog).getByRole('button', { name: 'attachmentPreview.next' });
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('link'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onRemove).not.toHaveBeenCalled();
    view.unmount();
    expect(new Set(vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url))).toEqual(new Set(created));
  });

  it('renders HTML as inert text and caps large text previews', async () => {
    const file = new File(['<script>alert(1)</script>', 'a'.repeat(300_000)], 'example.html', { type: 'text/html' });
    render(<AttachmentPreview files={[file]} initialFile={file} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('pre')?.textContent).toContain('<script>'));
    expect(screen.getByRole('dialog').querySelector('script')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('pre')!.textContent!.length).toBe(256 * 1024);
    expect(screen.getByText('attachmentPreview.truncated')).toBeTruthy();
  });

  it('provides a download fallback for unsupported files and failed images', () => {
    const file = new File(['zip'], 'archive.zip');
    const view = render(<AttachmentPreview files={[file]} initialFile={file} onClose={vi.fn()} />);
    expect(screen.getByText('attachmentPreview.unsupported')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('download')).toBe('archive.zip');
    view.unmount();
    const image = images()[0];
    render(<AttachmentPreview files={[image]} initialFile={image} onClose={vi.fn()} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('attachmentPreview.failed')).toBeTruthy();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('closes cleanly if submission removes the files and never keeps stale blob URLs', () => {
    const files = images(); const close = vi.fn();
    const view = render(<AttachmentPreview files={files} initialFile={files[2]} onClose={close} />);
    view.rerender(<AttachmentPreview files={[]} initialFile={files[2]} onClose={close} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(created[0]);
  });

  it.each([['doc.pdf', '', 'pdf'], ['a.mp3', 'audio/mpeg', 'audio'], ['a.mp4', 'video/mp4', 'video'], ['data.json', '', 'text'], ['notes.doc', '', 'unsupported']])('classifies %s safely', (name, type, kind) => {
    expect(attachmentPreviewKind({ name, type })).toBe(kind);
  });
});
