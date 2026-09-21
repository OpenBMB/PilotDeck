import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('message routes', () => {
  it('retains block IDs in the HTTP history returned to the browser', async () => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      gatewayEventToFrames: vi.fn(() => []),
      isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [
        { id: 'history-1', kind: 'thinking', text: 'same', turnId: 'turn-1', blockId: 'response-1:thinking:0' },
        { id: 'history-2', kind: 'text', role: 'assistant', text: 'same', turnId: 'turn-1', blockId: 'response-1:text:0', moduleId: 'staffdeck.knowledge' },
      ] })),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/sessions/session/messages`);
      const body = await response.json();
      expect(body.messages.map(message => message.blockId))
        .toEqual(['response-1:thinking:0', 'response-1:text:0']);
      expect(body.messages[1].moduleId).toBe('staffdeck.knowledge');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
  it.each([['Gateway WebSocket is not connected.', 503, 'gateway_unavailable'], ['Transcript read failed', 500, 'session_messages_read_failed']])('reports read failure %s instead of a successful empty transcript', async (message, status, code) => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      gatewayEventToFrames: vi.fn(() => []),
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
