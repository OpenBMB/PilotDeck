import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('message routes', () => {
  it('forwards context inspection only when explicitly requested and keeps it out of normal history', async () => {
    const breakdown = { systemTokens: 2200, toolsTokens: 10200, messageTokens: 65500 };
    const read = vi.fn(async () => ({ messages: [], modelContext: { version: 1, systemPrompt: 'real prompt', breakdown } }));
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: operation => operation({ readSessionMessages: read }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/sessions/s/messages?projectPath=/p`;
      expect((await (await nativeFetch(url)).json()).modelContext).toBeUndefined();
      expect(read.mock.calls[0][0].includeModelContext).toBeUndefined();
      const response = await nativeFetch(`${url}&includeModelContext=true&limit=1`);
      expect((await response.json()).modelContext.systemPrompt).toBe('real prompt');
      expect(read.mock.calls[1][0]).toMatchObject({ sessionKey: 's', projectKey: '/p', includeModelContext: true, limit: 1 });
      const summary = await (await nativeFetch(`${url}&includeModelContext=summary&limit=1`)).json();
      expect(summary.contextBreakdown).toEqual(breakdown);
      expect(summary.modelContext).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('real prompt');
      expect(read.mock.calls[2][0]).toMatchObject({ sessionKey: 's', projectKey: '/p', includeModelContext: true, limit: 1 });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  it('retains block IDs in the HTTP history returned to the browser', async () => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [
        { id: 'history-1', kind: 'thinking', text: 'same', turnId: 'turn-1', blockId: 'response-1:thinking:0' },
        { id: 'history-2', kind: 'text', role: 'assistant', text: 'same', turnId: 'turn-1', blockId: 'response-1:text:0' },
      ] })),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/sessions/session/messages`);
      expect((await response.json()).messages.map(message => message.blockId))
        .toEqual(['response-1:thinking:0', 'response-1:text:0']);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
  it.each([['Gateway WebSocket is not connected.', 503, 'gateway_unavailable'], ['Transcript read failed', 500, 'session_messages_read_failed']])('reports read failure %s instead of a successful empty transcript', async (message, status, code) => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      isGatewayUnavailableError: (error) => /Gateway WebSocket/i.test(error?.message || ''),
      withPilotDeckGatewayReadRetry: vi.fn(async () => {
        throw new Error(message);
      }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);

    try {
      const { port } = server.address();
      const response = await nativeFetch(
        `http://127.0.0.1:${port}/api/sessions/session-1/messages?projectPath=/workspace/project`,
      );
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
