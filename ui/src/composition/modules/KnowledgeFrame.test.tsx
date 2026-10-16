// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import KnowledgeFrame from './KnowledgeFrame';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('authenticates requests in the parent and handles upload, binary response, cancellation and unmount', async () => {
  const requests: FakeXHR[] = [];
  class FakeXHR {
    upload: { onprogress?: (event: unknown) => void } = {};
    headers: Record<string, string> = {};
    status = 200;
    response = new Uint8Array([80, 75]).buffer;
    onload?: () => void; onloadend?: () => void; onabort?: () => void;
    method = ''; url = ''; body: unknown; aborted = false;
    constructor() { requests.push(this); }
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    getResponseHeader(name: string) { return name === 'content-type' ? 'application/zip' : 'attachment; filename=knowledge.zip'; }
    send(body: unknown) { this.body = body; }
    abort() { this.aborted = true; this.onabort?.(); this.onloadend?.(); }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const navigate = vi.fn();
  const notify = vi.fn();
  const view = render(<KnowledgeFrame src="/km-ui/ui/v1/index.html" apiPath="/api/km/v1"
    navigate={navigate} notify={notify}
    headers={() => ({ Authorization: 'Bearer parent-only' })}
    directory={async () => ({ spaces: [{ id: 'a', name: 'Space' }], models: [] })} />);
  const frame = view.getByTitle('Knowledge') as HTMLIFrameElement;
  const channel = new URL(frame.src).hash.split('=')[1];
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const emit = async (value: object, source: MessageEventSource | null = frame.contentWindow, origin = location.origin) => {
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      data: { protocol: 'knowledge-frame/v1', channel, ...value }, source, origin,
    })));
  };
  await emit({ type: 'ready' });
  await emit({ type: 'navigate', path: '/knowledge/new' });
  await emit({ type: 'navigate', path: '/admin' });
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/knowledge/new');
  await emit({ type: 'notify', message: 'Completed', error: false });
  expect(notify).toHaveBeenCalledExactlyOnceWith('Completed', false);
  expect(JSON.stringify(post.mock.calls)).not.toContain('parent-only');
  await emit({ type: 'request', id: 'foreign', method: 'GET', path: '/api/km/v1/spaces' }, window);
  await emit({ type: 'request', id: 'bad', method: 'GET', path: '/api/km/v1/../admin' });
  expect(requests).toHaveLength(0);
  await emit({ type: 'request', id: 'upload', method: 'POST', path: '/api/km/v1/knowledge-bases/k/documents?space_id=a', body: '{}', upload: true });
  expect(requests[0].headers.Authorization).toBe('Bearer parent-only');
  expect(requests[0].url).toContain('space_id=a');
  requests[0].upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'progress', percent: 50 }), location.origin, []);
  requests[0].onload?.(); requests[0].onloadend?.();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'response', body: requests[0].response,
    headers: expect.objectContaining({ 'content-disposition': 'attachment; filename=knowledge.zip' }) }), location.origin, [requests[0].response]);
  await emit({ type: 'request', id: 'cancel', method: 'GET', path: '/api/km/v1/jobs/job' });
  await emit({ type: 'cancel', id: 'cancel' });
  expect(requests[1].aborted).toBe(true);
  await emit({ type: 'request', id: 'unmount', method: 'GET', path: '/api/km/v1/jobs/job' });
  view.unmount(); expect(requests[2].aborted).toBe(true);
});

it('shows incompatible protocol explicitly', async () => {
  const view = render(<KnowledgeFrame src="/km-ui/ui/v1/index.html" apiPath="/api/km/v1"
    headers={() => ({})} directory={async () => ({ spaces: [], models: [] })} />);
  const frame = view.getByTitle('Knowledge') as HTMLIFrameElement;
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
    origin: location.origin, data: { channel: new URL(frame.src).hash.split('=')[1], protocol: 'v2', type: 'ready' } })));
  expect(view.getByRole('alert').textContent).toContain('incompatible');
});
