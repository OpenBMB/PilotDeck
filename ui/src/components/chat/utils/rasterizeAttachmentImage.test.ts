// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rasterizeAttachmentImage } from './rasterizeAttachmentImage';

class Decoder {
  src = '';
  naturalWidth = 800;
  naturalHeight = 400;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute() { this.src = ''; }
}
let decoders: Decoder[];
let signals: AbortController[];
const draw = vi.fn();
const encode = vi.fn();
beforeEach(() => {
  decoders = []; signals = [];
  draw.mockClear();
  encode.mockReset();
  encode.mockImplementation((callback: BlobCallback) => callback(new Blob(['encoded pixels'], { type: 'image/png' })));
  vi.stubGlobal('Image', class extends Decoder { constructor() { super(); decoders.push(this); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(encode);
  vi.stubGlobal('URL', { createObjectURL: vi.fn() });
});
afterEach(() => { signals.forEach(c => c.abort()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start(file = new File(['<svg/>'], 'image.svg'), edge = 256) {
  const controller = new AbortController(); signals.push(controller);
  const task = rasterizeAttachmentImage(file, edge, controller.signal);
  return { controller, task };
}

it('decodes opaque data URLs and exports bounded PNG pixels without creating a raw object URL', async () => {
  const { task } = start();
  await vi.waitFor(() => expect(decoders[0]?.src).toBe('data:image/svg+xml;base64,PHN2Zy8+'));
  decoders[0].onload!();
  expect((await task).type).toBe('image/png');
  expect(draw).toHaveBeenCalledWith(decoders[0], 0, 0, 256, 128);
  expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(decoders[0].src).toBe('');
  expect(decoders[0].onload).toBeNull();
});

it('limits concurrency, removes cancelled queued jobs, and releases active decoders', async () => {
  const jobs = [start(), start(), start(), start()];
  const settled = Promise.allSettled(jobs.map(j => j.task));
  await vi.waitFor(() => expect(decoders.filter(d => d.src)).toHaveLength(2));
  jobs[2].controller.abort();
  jobs[0].controller.abort();
  await vi.waitFor(() => expect(decoders).toHaveLength(3));
  expect(decoders[0].src).toBe('');
  jobs[1].controller.abort();
  jobs[3].controller.abort();
  expect((await settled).every(r => r.status === 'rejected' && r.reason.name === 'AbortError')).toBe(true);
  expect(encode).not.toHaveBeenCalled();
});

it.each(['decode', 'dimensions', 'encode'])('fails closed on %s failure', async (failure) => {
  const { task } = start();
  const result = task.catch(error => error);
  await vi.waitFor(() => expect(decoders[0]?.src).toBeTruthy());
  if (failure === 'decode') decoders[0].onerror!();
  else {
    if (failure === 'dimensions') decoders[0].naturalWidth = 100_000_000;
    if (failure === 'encode') encode.mockImplementation((callback: BlobCallback) => callback(null));
    decoders[0].onload!();
  }
  expect(await result).toBeInstanceOf(Error);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(decoders[0].src).toBe('');
});

it('rejects unsupported, oversized and already-cancelled files without starting a decoder', async () => {
  await expect(start(new File(['text'], 'file.txt')).task).rejects.toThrow('Unsupported');
  await expect(start({ name: 'huge.png', size: 33 * 1024 * 1024, type: 'image/png' } as File).task).rejects.toThrow('oversized');
  const cancelled = new AbortController(); cancelled.abort();
  await expect(rasterizeAttachmentImage(new File(['image'], 'image.png'), 256, cancelled.signal)).rejects.toThrow('cancelled');
  expect(decoders).toHaveLength(0);
});
