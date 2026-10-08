// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { prepareBackgroundImage, loadBackgroundImage, saveBackgroundImage, createBackgroundImageId } from './appearanceImages';
import { isImageId } from './lightAppearance';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.pilotdeckDesktop = undefined; });
it('creates valid managed image ids on HTTP origins without randomUUID', () => {
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) });
  const id = createBackgroundImageId();
  expect(isImageId(id)).toBe(true);
  expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff.png');
});
it('rejects unsupported formats and oversized images before decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(prepareBackgroundImage(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).rejects.toThrow('invalidImage');
  await expect(prepareBackgroundImage(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'x.png', { type: 'image/png' }))).rejects.toThrow('invalidImage');
  expect(decode).not.toHaveBeenCalled();
});
it('reports corrupt images and malformed stored image ids', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));
  await expect(prepareBackgroundImage(new File(['broken'], 'x.png', { type: 'image/png' }))).rejects.toThrow('invalidImage');
  await expect(loadBackgroundImage('../../file')).rejects.toThrow('imageMissing');
});
it('resizes a large image to a bounded PNG and propagates persistence errors', async () => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 7680, height: 4320, close }));
  const draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
    expect(this.width).toBe(3840); expect(this.height).toBe(2160);
    callback(new Blob(['compressed'], { type: 'image/png' }));
  });
  // jsdom's Blob does not expose arrayBuffer in every version.
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(10));
  window.pilotdeckDesktop = { saveAppearanceImage: vi.fn().mockRejectedValue(new Error('disk full')) } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  await expect(saveBackgroundImage(new File(['test'], 'x.png', { type: 'image/png' }))).rejects.toThrow('disk full');
  expect(close).toHaveBeenCalledTimes(1);
});
