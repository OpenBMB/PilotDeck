import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const mocks = vi.hoisted(() => ({ state: 'ready' }));
vi.mock('../services/modelConfigurationState.js', () => ({ getModelConfigurationState: () => ({ state: mocks.state }) }));
beforeEach(() => { mocks.state = 'ready'; });

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('model routes', () => {
  it('returns an empty catalog without connecting to Gateway for a cleared pool', async () => {
    mocks.state = 'empty';
    const getGateway = vi.fn(() => { throw new Error('Gateway must remain stopped'); });
    vi.doMock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: getGateway }));
    const { default: routes } = await import('./models.js');
    const app = express(); app.use('/api/models', routes);
    const server = app.listen(0);
    try {
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/models?includeAuto=true`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [], defaultSelection: null, router: { enabled: false, autoAvailable: false } });
      expect(getGateway).not.toHaveBeenCalled();
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

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
    const error = Object.assign(new Error('reasoning effort is unsupported'), {
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
