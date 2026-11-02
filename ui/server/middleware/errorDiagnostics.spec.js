// @vitest-environment node
import { expect, it } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { createErrorDiagnostics, handleUnexpectedError } from './errorDiagnostics.js';

it('adds diagnostic codes, IDs and log paths to handled and unexpected failures', async () => {
  const app = express(); app.use(createErrorDiagnostics('C:/用户/.pilotdeck/logs/runtime.log'));
  app.get('/handled', (_req, res) => res.status(401).json({ error: 'Authentication required' }));
  app.get('/custom', (_req, res) => res.status(409).json({ code: 'revision_conflict', error: 'Changed' }));
  app.get('/unknown', () => { throw new Error('unexpected secret-free test error'); });
  app.use(handleUnexpectedError);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (const [route, code] of [['handled', 'PD_AUTH_REJECTED'], ['custom', 'PD_OPERATION_CONFLICT'], ['unknown', 'PD_UNEXPECTED_ERROR']]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}`), body = await response.json();
      expect(body.diagnosticCode).toBe(code); expect(body.diagnosticId).toMatch(/^[\da-f-]{36}$/); expect(body.logPath).toContain('用户');
      if (route === 'custom') expect(body.code).toBe('revision_conflict');
      if (route === 'unknown') expect(body.error).not.toContain('test error');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
