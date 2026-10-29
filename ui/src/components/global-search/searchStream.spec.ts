import { describe, expect, it } from 'vitest';
import { readSearchResponse } from './searchStream';

const encode = new TextEncoder();
function response(bytes: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) { for (const part of bytes) controller.enqueue(part); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });
}
describe('incremental search stream', () => {
  it('handles byte boundaries through Chinese UTF-8, CRLF, and multiple snapshots', async () => {
    const text = 'event: snapshot\r\ndata: {"title":"中文"}\r\n\r\nevent: done\r\ndata: {"title":"完整"}\r\n\r\n';
    const snapshots: unknown[] = [];
    const bytes = encode.encode(text);
    const result = await readSearchResponse(response([...bytes].map(byte => Uint8Array.of(byte))), value => snapshots.push(value), new AbortController().signal);
    expect(snapshots).toEqual([{ title: '中文' }, { title: '完整' }]);
    expect(result).toEqual({ title: '完整' });
  });
  it('rejects truncated streams and server errors', async () => {
    await expect(readSearchResponse(response([encode.encode('event: snapshot\ndata: {}\n\n')]), () => {}, new AbortController().signal)).rejects.toThrow('Incomplete');
    await expect(readSearchResponse(response([encode.encode('event: error\ndata: {"error":"failed"}\n\n')]), () => {}, new AbortController().signal)).rejects.toThrow('failed');
  });
  it('stops delivering snapshots when the request is aborted', async () => {
    const controller = new AbortController(); const snapshots: unknown[] = [];
    await expect(readSearchResponse(response([encode.encode('event: snapshot\ndata: {"first":true}\n\nevent: done\ndata: {}\n\n')]), value => {
      snapshots.push(value); controller.abort();
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(snapshots).toEqual([{ first: true }]);
  });
});
