import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('message routes', () => {
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


describe('delivery history', () => {
  it.each(['agent','task'])('preserves %s delivery receipts when a session is reopened', async (toolName) => {
    const payload={delivery_file:'.pilotdeck/deliveries/child/attempt-2.json',delivery:{status:'passed',repairs:1,attempts:[{attempt:2,checks:{status:'passed',checked:1,issues:[]}}]}};
    vi.doMock('../pilotdeck-bridge.js',()=>({getPilotDeckGateway:vi.fn(),isGatewayUnavailableError:()=>false,
      withPilotDeckGatewayReadRetry:vi.fn(async()=>({messages:[{id:'m1',kind:'tool_result',toolName,toolCallId:'c1',ok:true,text:'Delivery saved.',payload}],total:1,hasMore:false}))}));
    const {default:routes}=await import('./messages.js');const app=express();app.use('/api/sessions',routes);const server=app.listen(0);
    try {const {port}=server.address();const response=await nativeFetch(`http://127.0.0.1:${port}/api/sessions/s1/messages?projectPath=/workspace`);
      expect(response.status).toBe(200);expect((await response.json()).messages[0].toolUseResult).toEqual(payload);
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
});
