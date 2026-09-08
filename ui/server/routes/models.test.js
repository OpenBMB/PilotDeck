import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('model routes', () => {
  it('serves the global catalog without passing project scope to the gateway', async () => {
    const modelCatalogList = vi.fn(async () => ({ items: [], defaultSelection: { mode: 'auto' } }));
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        describeServer: vi.fn(async () => ({ capabilities: ['model_catalog_list'] })), modelCatalogList,
      })),
    }));
    const { default: routes } = await import('./models.js');
    const app = express(); app.use('/api/models', routes);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      for (const suffix of ['', '&projectKey=/old-project']) {
        const response = await nativeFetch(`http://127.0.0.1:${port}/api/models?includeAuto=true${suffix}`);
        expect(response.status).toBe(200);
        await response.json();
      }
      expect(modelCatalogList.mock.calls.map(([input]) => input)).toEqual([
        { query: undefined, provider: undefined, includeAuto: true },
        { query: undefined, provider: undefined, includeAuto: true },
      ]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('returns 422 for unsupported model parameters', async () => {
    const error = Object.assign(new Error('temperature is unsupported'), {
      code: 'UNSUPPORTED_MODEL_PARAMETER',
    });
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(async () => ({
        describeServer: vi.fn(async () => ({ capabilities: ['model_catalog_list'] })),
        modelCatalogList: vi.fn(async () => { throw error; }),
      })),
    }));
    const { default: routes } = await import('./models.js');
    const app = express();
    app.use('/api/models', routes);
    const server = app.listen(0);

    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/models?projectKey=/project`);
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('UNSUPPORTED_MODEL_PARAMETER');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
