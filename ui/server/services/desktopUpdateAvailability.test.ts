// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { probeUpdateDownload, checkUpdateDownload } from '../../../apps/desktop/src/updateNetwork';
import { createDesktopReleaseService } from './desktopReleaseService.js';

afterEach(() => vi.useRealTimers());

// An Electron request double delivering 32 KiB/s, including transport cleanup.
function slowExecutor(options: { statusCode?: number; headers?: Record<string, string | number>; chunkBytes?: number; end?: boolean } = {}) {
  const requests: Array<{ abort: ReturnType<typeof vi.fn> }> = [];
  const executor = {
    createRequest(_options: unknown, callback: (response: unknown) => void) {
      const response = Object.assign(new EventEmitter(), { statusCode: options.statusCode ?? 200,
        headers: options.headers ?? { 'content-type': 'application/octet-stream', 'content-length': 1048576 } });
      let timer: ReturnType<typeof setInterval>;
      const request = Object.assign(new EventEmitter(), {
        abort: vi.fn(() => clearInterval(timer)),
        end() {
          timer = setInterval(() => {
            response.emit('data', Buffer.alloc(options.chunkBytes ?? 32768));
            if (options.end) response.emit('end');
          }, 1000);
          callback(response);
        },
      });
      requests.push(request);
      return request;
    },
  } as unknown as Parameters<typeof probeUpdateDownload>[0];
  return { executor, requests };
}

it('offers the update when both mirrors continuously serve only 32 KiB/s', async () => {
  vi.useFakeTimers();
  const { executor, requests } = slowExecutor();
  const probe = vi.fn(() => { throw new Error('Speed sampling must not gate availability'); });
  const service = createDesktopReleaseService({ probe, checkDownload: (url: string, signal: AbortSignal, size: number) =>
    checkUpdateDownload(executor, url, signal, size) });
  const available = service.downloadAvailable({ tagName: 'v2026.10.29' }, { name: 'installer.exe', size: 1048576 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await available).toBe(true);
  expect(probe).not.toHaveBeenCalled();
  expect(requests).toHaveLength(2);
  expect(requests.every(request => request.abort.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a slow route as a download fallback even when its speed sample times out', async () => {
  vi.useFakeTimers();
  const { executor } = slowExecutor();
  const service = createDesktopReleaseService({ probe: (url: string, signal: AbortSignal, size: number) =>
    probeUpdateDownload(executor, url, signal, size) });
  const ranked = service.downloadBases({ tagName: 'v2026.10.29' }, { name: 'installer.exe', size: 1048576 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await ranked).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { statusCode: 404 }, { statusCode: 503 },
  { headers: { 'content-type': 'text/html' } },
  { headers: { 'content-type': 'application/json' } },
  { headers: { 'content-length': 99 } },
  { statusCode: 206, headers: {} },
  { statusCode: 206, headers: { 'content-range': 'bytes 0-0/99' } },
  { chunkBytes: 0, end: true },
])('still rejects absent, invalid or empty payloads: %j', async options => {
  vi.useFakeTimers();
  const { executor, requests } = slowExecutor(options);
  const checking = expect(checkUpdateDownload(executor, 'https://example.test/installer.exe', undefined, 1048576)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  await checking;
  expect(requests[0].abort).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts a valid one-byte Range response without imposing a minimum transfer rate', async () => {
  vi.useFakeTimers();
  const { executor } = slowExecutor({ statusCode: 206, headers: { 'content-range': 'bytes 0-0/1048576' }, chunkBytes: 1 });
  const checking = checkUpdateDownload(executor, 'https://example.test/installer.exe', undefined, 1048576);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(checking).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['timeout', 'cancel'])('cleans up requests that never deliver a payload byte: %s', async reason => {
  vi.useFakeTimers();
  const { executor, requests } = slowExecutor({ chunkBytes: 0 });
  const controller = new AbortController();
  const checking = expect(checkUpdateDownload(executor, 'https://example.test/installer.exe', controller.signal, 1048576))
    .rejects.toThrow(reason === 'timeout' ? 'probeTimeout' : 'cancelled');
  if (reason === 'cancel') controller.abort();
  await vi.advanceTimersByTimeAsync(5000);
  await checking;
  expect(requests[0].abort).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
