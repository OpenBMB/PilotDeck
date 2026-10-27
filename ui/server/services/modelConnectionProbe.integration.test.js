// @vitest-environment node
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareConnectionTest } from '../routes/onboarding.js';

const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('connection probes with real HTTP response bodies', () => {
  it.each(['timeout', 'cancel'])('aborts a stalled body on %s and releases the connection-test slot', async (mode) => {
    let stall = true;
    let requestSignal;
    let headersReceived = false;
    let closed;
    const upstreamClosed = new Promise((resolve) => { closed = resolve; });
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (stall) {
        res.on('close', closed);
        res.write('\n');
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: 'red' } }] }));
      }
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      // Accelerate only the production probe deadline; use real HTTP and timers.
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => (
        nativeSetTimeout(callback, ms === 60_000 ? 500 : ms, ...args)
      ));
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        requestSignal = init.signal;
        const response = await nativeFetch(url, init);
        headersReceived = true;
        return response;
      }));
      const body = {
        providerId: 'local-regression', protocol: 'openai',
        endpoint: `http://127.0.0.1:${upstream.address().port}/v1`,
        apiKey: 'test-only', models: ['test-model'], retryPolicy: { maxRetries: 0 },
      };
      const caller = new AbortController();
      const run = prepareConnectionTest(body, `body-${mode}`);
      const pending = run(caller.signal);
      await vi.waitFor(() => expect(headersReceived).toBe(true), { interval: 5 });
      if (mode === 'cancel') {
        const reason = new Error('Client disconnected.');
        const rejected = expect(pending).rejects.toBe(reason);
        caller.abort(reason);
        await rejected;
      } else {
        await expect(pending).resolves.toMatchObject({
          status: 'failed',
          models: [{ textInput: 'unsupported', error: { message: 'Connection timed out after 60s.' } }],
        });
      }
      expect(requestSignal.aborted).toBe(true);
      await upstreamClosed;
      stall = false;
      // The same user can immediately reserve the single per-user slot again.
      const retry = prepareConnectionTest(body, `body-${mode}`);
      await expect(retry(new AbortController().signal)).resolves.toMatchObject({
        status: 'passed', models: [{ textInput: 'supported', imageInput: 'supported' }],
      });
    } finally {
      await new Promise((resolve) => {
        upstream.close(resolve);
        upstream.closeAllConnections();
      });
    }
  });
});
