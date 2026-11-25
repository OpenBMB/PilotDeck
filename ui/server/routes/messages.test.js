import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('message routes', () => {
  it('preserves transcript entry IDs and the fork HTTP contract using a synthetic session', async () => {
    const projectPath = '/fixture/a workspace';
    const gateway = {
      readSessionMessages: vi.fn(async () => ({ messages: [
        { id: 'first', entryId: 'first-entry', kind: 'text', role: 'user', text: 'Earlier request' },
        { id: 'answer', entryId: 'answer-entry', kind: 'text', role: 'assistant', text: 'Earlier answer' },
        { id: 'point', entryId: 'fork-entry', kind: 'text', role: 'user', text: 'Continue here' },
      ], total: 3 })),
      forkSession: vi.fn(async () => ({ newSessionKey: 'web:s_fork-fixture', prefillText: 'Continue here', carriedMessageCount: 2 })),
    };
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: async () => gateway, isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: operation => operation(gateway),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use(express.json()); app.use('/api/sessions', routes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/sessions/web%3As_source`;
    try {
      const history = await nativeFetch(`${base}/messages?${new URLSearchParams({ projectPath, limit: '200' })}`);
      expect(history.status).toBe(200);
      const { messages } = await history.json();
      const point = messages.find(message => message.entryId === 'fork-entry');
      expect(point).toMatchObject({ role: 'user', entryId: 'fork-entry' });
      const response = await nativeFetch(`${base}/fork`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, fromEntryId: point.entryId }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ newSessionId: 'web:s_fork-fixture', prefillText: 'Continue here', carriedMessageCount: 2 });
      expect(gateway.forkSession).toHaveBeenCalledExactlyOnceWith({
        sessionKey: 'web:s_source', projectKey: projectPath, fromEntryId: 'fork-entry',
      });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  it('rejects a fork without an entry ID before contacting Gateway', async () => {
    const getGateway = vi.fn();
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: getGateway,
      isGatewayUnavailableError: () => false, withPilotDeckGatewayReadRetry: vi.fn() }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use(express.json()); app.use('/api/sessions', routes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    try {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/source/fork`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: '/fixture/demo' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'fromEntryId is required' });
      expect(getGateway).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  it.each([['fork_entry_not_found', 400], ['gateway_unavailable', 500]])('returns %s fork failures over HTTP', async (code, status) => {
    const error = Object.assign(new Error('Synthetic fork failure'), { code });
    const forkSession = vi.fn().mockRejectedValue(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: async () => ({ forkSession }),
      isGatewayUnavailableError: () => false, withPilotDeckGatewayReadRetry: vi.fn() }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use(express.json()); app.use('/api/sessions', routes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    try {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/source/fork`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: '/fixture/demo', fromEntryId: 'missing-entry' }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: error.message, ...(status === 400 ? { code } : {}) });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  it('preserves guidance identity from Gateway history for live/history reconciliation', async () => {
    const timeline = { version: 1, turnId: 'run', id: 'steer:guidance', order: 4, revision: 12 };
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: async () => ({ messages: [{ id: 'steer-history', turnId: 'run', kind: 'text', role: 'user',
        text: 'Use primary sources', timeline, queueItemId: 'guidance', isSteer: true }] }),
    }));
    const { default: routes } = await import('./messages.js'); const app = express(); app.use('/api/sessions', routes); const server = app.listen(0);
    try {
      const body = await (await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/cron:task/messages`)).json();
      expect(body.messages[0]).toMatchObject({ timeline, queueItemId: 'guidance', isSteer: true, isFinal: true });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  it('retains authoritative timing on a historical turn anchor', async () => {
    const turnTiming = { startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:01:20Z', finishReason: 'model_error' };
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: async () => ({ messages: [{ id: 'user', turnId: 'r', kind: 'text', role: 'user', text: 'Inspect', turnTiming }] }),
    }));
    const { default: routes } = await import('./messages.js'); const app = express(); app.use('/api/sessions', routes); const server = app.listen(0);
    try {
      const body = await (await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/s/messages`)).json();
      expect(body.messages[0].turnTiming).toEqual(turnTiming);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  it('restores a model image omission with the same notice identity as the live frame', async () => {
    const contentI18n = { key: 'chat:agentStatus.modelImagesOmitted.message' };
    const read = vi.fn(async () => ({
      messages: [{
        id: 'transcript-entry', kind: 'status', turnId: 'run', text: 'Images were omitted.', contentI18n,
        payload: { event: 'model_images_omitted', detail: { visible: true } },
      }],
      total: 1,
    }));
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: operation => operation({ readSessionMessages: read }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const body = await (await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/s/messages`)).json();
      expect(body.messages).toMatchObject([{
        id: 'model-images-omitted:run', kind: 'agent_notice', content: 'Images were omitted.', contentI18n,
      }]);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('forwards backward identity cursors and history replacement without converting them to offsets', async () => {
    const read = vi.fn(async () => ({ messages: [], total: 250, nextCursor: 'before:old-user', historyReset: true }));
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: operation => operation({ readSessionMessages: read }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use('/api/sessions', routes); const server = app.listen(0);
    try {
      const body = await (await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/s/messages?direction=backward&cursor=before%3Acurrent-user&limit=100`)).json();
      expect(read.mock.calls[0][0]).toMatchObject({ sessionKey: 's', direction: 'backward', cursor: 'before:current-user', limit: 100 });
      expect(body).toMatchObject({ hasMore: true, nextCursor: 'before:old-user', historyReset: true, total: 250 });
      await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/s/messages?direction=backward&includeFromId=old-user&limit=100`);
      expect(read.mock.calls[1][0]).toMatchObject({ direction: 'backward', includeFromId: 'old-user', limit: 100 });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  it('forwards context inspection only when explicitly requested and keeps it out of normal history', async () => {
    const breakdown = { systemTokens: 2200, toolsTokens: 10200, messageTokens: 65500 };
    const lastTurnUsage = { turnId: 'r', completedAt: '2026-09-01T00:01:00Z', usage: { inputTokens: 5000, cacheReadTokens: 5000 } };
    const read = vi.fn(async () => ({ messages: [], lastTurnUsage, modelContext: { version: 1, systemPrompt: 'real prompt', breakdown } }));
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: operation => operation({ readSessionMessages: read }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express(); app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/sessions/s/messages?projectPath=/p`;
      const normal = await (await nativeFetch(url)).json();
      expect(normal.modelContext).toBeUndefined();
      expect(normal.lastTurnUsage).toBeUndefined();
      expect(read.mock.calls[0][0].includeModelContext).toBeUndefined();
      const response = await nativeFetch(`${url}&includeModelContext=true&limit=1`);
      expect((await response.json()).modelContext.systemPrompt).toBe('real prompt');
      expect(read.mock.calls[1][0]).toMatchObject({ sessionKey: 's', projectKey: '/p', includeModelContext: true, limit: 1 });
      const summary = await (await nativeFetch(`${url}&includeModelContext=summary&limit=1`)).json();
      expect(summary.contextBreakdown).toEqual(breakdown);
      expect(summary.lastTurnUsage).toEqual(lastTurnUsage);
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

it.each(['generate_video', 'save_generated_video'])('retains %s attachment identity and purpose through HTTP history recovery', async toolName => {
  const videoGeneration = { videoId: 'video-id', sessionId: 'web:session', path: '/managed/video.mp4', mimeType: 'video/mp4', purpose: 'deliverable' };
  vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
    withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [{ id: 'result', kind: 'tool_result', toolName,
      toolCallId: 'video-call', text: 'Video attached', ok: true, payload: { videoGeneration } }] })),
  }));
  const { default: routes } = await import('./messages.js'); const app = express(); app.use('/api/sessions', routes); const server = app.listen(0);
  try {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/web:session/messages`);
    expect((await response.json()).messages[0]).toMatchObject({ kind: 'tool_result', toolId: 'video-call', toolUseResult: { videoGeneration } });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

it.each(['ask_user_question', 'AskUserQuestion'])('retains %s answers and multi-select boundaries through HTTP history recovery', async toolName => {
  const payload = { questions: [{ question: 'Which paths?', header: 'Scope', multiSelect: true,
    options: [{ label: 'A, B', description: 'A combined label' }, { label: 'C', description: 'Another path' }] }],
    answers: { 'Which paths?': ['A, B', 'C', 'Custom, answer'] } };
  vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: vi.fn(), isGatewayUnavailableError: () => false,
    withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [{ id: 'answer-result', kind: 'tool_result', toolName,
      toolCallId: 'question-call', text: 'User has answered', ok: true, payload }] })),
  }));
  const { default: routes } = await import('./messages.js');
  const app = express(); app.use('/api/sessions', routes); const server = app.listen(0);
  try {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/sessions/question-session/messages`);
    expect((await response.json()).messages[0]).toMatchObject({ kind: 'tool_result', toolId: 'question-call', toolUseResult: payload });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
