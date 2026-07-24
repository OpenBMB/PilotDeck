import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('user onboarding status route', () => {
  it('treats Ollama providers without an API key as completed onboarding', async () => {
    const { request } = await createUserApp({
      exists: true,
      config: {
        agent: { model: 'ollama/qwen3:0.6b' },
        model: {
          providers: {
            ollama: {
              protocol: 'openai',
              url: 'http://localhost:11434/v1',
              models: { 'qwen3:0.6b': {} },
            },
          },
        },
      },
    });

    const data = await request('/api/user/onboarding-status');

    expect(data).toMatchObject({
      success: true,
      hasCompletedOnboarding: true,
    });
  });

  it('still requires an API key for non-local providers', async () => {
    const { request } = await createUserApp({
      exists: true,
      config: {
        agent: { model: 'openai/gpt-4.1-mini' },
        model: {
          providers: {
            openai: {
              protocol: 'openai',
              url: 'https://api.openai.com/v1',
              models: { 'gpt-4.1-mini': {} },
            },
          },
        },
      },
    });

    const data = await request('/api/user/onboarding-status');

    expect(data).toMatchObject({
      success: true,
      hasCompletedOnboarding: false,
    });
  });

  it('accepts Codex subscription credentials without an API key', async () => {
    const { request } = await createUserApp({
      exists: true,
      config: {
        agent: { model: 'codex/gpt-5.6-sol' },
        model: {
          providers: {
            codex: {
              protocol: 'openai-responses',
              url: 'https://chatgpt.com/backend-api/codex',
              apiKey: '',
              models: { 'gpt-5.6-sol': {} },
            },
          },
        },
      },
    }, { codexAuthenticated: true });

    const data = await request('/api/user/onboarding-status');

    expect(data).toMatchObject({
      success: true,
      hasCompletedOnboarding: true,
    });
  });
});

async function createUserApp(record, { codexAuthenticated = false } = {}) {
  vi.doMock('../database/db.js', () => ({
    userDb: {
      getGitConfig: vi.fn(),
      updateGitConfig: vi.fn(),
    },
  }));
  vi.doMock('../middleware/auth.js', () => ({
    authenticateToken: (req, _res, next) => {
      req.user = { id: 1, username: 'test' };
      next();
    },
  }));
  vi.doMock('../utils/gitConfig.js', () => ({
    getSystemGitConfig: vi.fn(async () => ({ git_name: null, git_email: null })),
  }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => record),
  }));
  vi.doMock('../../../src/model/providers/codex/auth.js', () => ({
    getCodexAuthStatus: vi.fn(async () => ({
      authenticated: codexAuthenticated,
      importAvailable: false,
    })),
  }));

  const { default: userRoutes } = await import('./user.js');
  const app = express();
  app.use(express.json());
  app.use('/api/user', userRoutes);

  return {
    request: (path, init) => requestBodyJson(app, path, init),
  };
}

async function requestBodyJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
