import express from 'express';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('onboarding routes', () => {
  it('returns preset providers in catalog order with logos', async () => {
    const { request } = await createOnboardingApp();
    const result = await request('/api/v1/providers');
    expect(result.status).toBe(200);
    expect(result.body.providers.map((item) => item.id)).toEqual([
      'anthropic', 'openai', 'openai-responses', 'dashscope', 'deepseek', 'google',
      'openrouter', 'ollama', 'minimax', 'moonshot', 'volc_ark', 'zhipu',
    ]);
    expect(result.body.providers[0]).toEqual({
      id: 'anthropic',
      displayName: 'Anthropic',
      protocol: 'anthropic',
      endpoint: 'https://api.anthropic.com',
      logoUrl: '/onboarding/providers/anthropic.svg',
      requiresApiKey: true,
    });
    expect(result.body.providers.find((item) => item.id === 'ollama')).toEqual({
      id: 'ollama',
      displayName: 'Ollama',
      protocol: 'openai',
      endpoint: 'http://localhost:11434/v1',
      logoUrl: '/onboarding/providers/ollama.svg',
      requiresApiKey: false,
    });
    expect(result.body.providers.find((item) => item.id === 'openai-responses').logoUrl).toBe('/onboarding/providers/openai.svg');
  });

  it('maps prototype provider aliases and requires manual image completion', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'upstream 500', imageUnsupported: false });
    const { request } = await createOnboardingApp({ probe });
    const result = await request('/api/v1/model-connection-tests', {
      method: 'POST', headers: { 'x-user': 'one' }, body: JSON.stringify({
        providerId: 'gemini', apiKey: 'key', models: ['gemini-test'], retryPolicy: retryPolicy(), endpoint: 'https://ignored.example', protocol: 'openai',
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('manual_input_required');
    expect(probe).toHaveBeenNthCalledWith(1, expect.objectContaining({ protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com' }));

    const incomplete = await request(`/api/v1/model-connection-tests/${result.body.testId}/image-capabilities`, {
      method: 'PUT', headers: { 'x-user': 'one' }, body: JSON.stringify({ models: [{ modelId: 'wrong-model', imageInput: 'supported' }] }),
    });
    expect(incomplete.status).toBe(400);

    const completed = await request(`/api/v1/model-connection-tests/${result.body.testId}/image-capabilities`, {
      method: 'PUT', headers: { 'x-user': 'one' }, body: JSON.stringify({ models: [{ modelId: 'gemini-test', imageInput: 'supported' }] }),
    });
    expect(completed.body.status).toBe('passed');
    expect(completed.body.error).toBeNull();
  });

  it('trims manually supplied image capability model IDs before updating', async () => {
    const { request } = await createOnboardingApp({
      probe: vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, imageUnsupported: false, error: 'unknown' }),
    });
    const test = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['model-a'], retryPolicy: retryPolicy() }),
    });
    const completed = await request(`/api/v1/model-connection-tests/${test.body.testId}/image-capabilities`, {
      method: 'PUT', body: JSON.stringify({ models: [{ modelId: ' model-a ', imageInput: 'supported' }] }),
    });
    expect(completed).toMatchObject({ status: 200, body: { status: 'passed', error: null, models: [{ modelId: 'model-a', imageInput: 'supported' }] } });
  });

  it('isolates test IDs by user and writes the tested model configuration', async () => {
    const writePilotDeckConfig = vi.fn(async (config) => ({ config }));
    const { request } = await createOnboardingApp({
      probe: vi.fn().mockResolvedValue({ ok: true }),
      writePilotDeckConfig,
      config: {
        schemaVersion: 1,
        agent: {},
        model: { providers: { openai: { protocol: 'openai', url: 'https://api.openai.com/v1', apiKey: 'key', retry: { jitter: true, repeatedChunkLimit: 4 }, models: { 'keep-me': { multimodal: { input: ['text'] } } } } } },
        webui: {},
      },
    });
    const test = await request('/api/v1/model-connection-tests', {
      method: 'POST', headers: { 'x-user': 'one' }, body: JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['gpt-test'], retryPolicy: retryPolicy() }),
    });
    const otherUser = await request(`/api/v1/model-connection-tests/${test.body.testId}/image-capabilities`, {
      method: 'PUT', headers: { 'x-user': 'two' }, body: JSON.stringify({ models: [{ modelId: 'gpt-test', imageInput: 'supported' }] }),
    });
    expect(otherUser.status).toBe(404);
    const saved = await request('/api/v1/model-configuration', {
      method: 'PUT', headers: { 'x-user': 'one' }, body: JSON.stringify({
        testId: test.body.testId, providerId: 'openai', apiKey: 'key', models: [{ modelId: 'gpt-test', textInput: true, imageInput: true }], retryPolicy: retryPolicy(),
      }),
    });
    expect(saved.status).toBe(200);
    expect(writePilotDeckConfig).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ model: 'openai/gpt-test' }),
      model: expect.objectContaining({ providers: expect.objectContaining({ openai: expect.objectContaining({ retry: expect.objectContaining({ requestMaxRetries: 2, jitter: true, repeatedChunkLimit: 4 }), models: expect.objectContaining({ 'keep-me': { multimodal: { input: ['text'] } }, 'gpt-test': { multimodal: { input: ['text', 'image'] } } }) }) }) }),
    }));
  });

  it('requires the exact tested model set and retry policy when saving', async () => {
    const { request } = await createOnboardingApp({ probe: vi.fn().mockResolvedValue({ ok: true }) });
    const test = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['model-a', 'model-b'], retryPolicy: retryPolicy() }),
    });
    const duplicateModels = [{ modelId: 'model-a', textInput: true, imageInput: true }, { modelId: 'model-a', textInput: true, imageInput: true }];
    const duplicate = await request('/api/v1/model-configuration', {
      method: 'PUT', body: JSON.stringify({ testId: test.body.testId, providerId: 'openai', apiKey: 'key', models: duplicateModels, retryPolicy: retryPolicy() }),
    });
    expect(duplicate).toMatchObject({ status: 409, body: { code: 'CONFIGURATION_MISMATCH' } });
    const changedRetry = await request('/api/v1/model-configuration', {
      method: 'PUT', body: JSON.stringify({ testId: test.body.testId, providerId: 'openai', apiKey: 'key', models: [{ modelId: 'model-a', textInput: true, imageInput: true }, { modelId: 'model-b', textInput: true, imageInput: true }], retryPolicy: { ...retryPolicy(), maxRetries: 4 } }),
    });
    expect(changedRetry).toMatchObject({ status: 409, body: { code: 'CONFIGURATION_MISMATCH' } });
  });

  it('rejects loose retry policies and invalid custom provider IDs', async () => {
    const { request } = await createOnboardingApp({ probe: vi.fn().mockResolvedValue({ ok: true }) });
    const looseRetry = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['model-a'], retryPolicy: { maxRetries: '2' } }),
    });
    expect(looseRetry).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    const slashProvider = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'my/team', protocol: 'openai', endpoint: 'https://example.test', apiKey: 'key', models: ['model-a'], retryPolicy: retryPolicy() }),
    });
    expect(slashProvider).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });

  it('treats Object prototype property names as custom providers', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const { request } = await createOnboardingApp({ probe });
    for (const providerId of ['constructor', 'toString']) {
      const response = await request('/api/v1/model-connection-tests', {
        method: 'POST', body: JSON.stringify({
          providerId, protocol: 'openai', endpoint: 'https://custom.example/v1', apiKey: 'key', models: ['model-a'], retryPolicy: retryPolicy(),
        }),
      });
      expect(response.status).toBe(200);
    }
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'openai', baseUrl: 'https://custom.example/v1' }));
  });

  it('uses the documented aggregate error for text failures', async () => {
    const { request } = await createOnboardingApp({ probe: vi.fn().mockResolvedValue({ ok: false, code: 'MODEL_NOT_FOUND', error: 'unknown model' }) });
    const response = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['missing-model'], retryPolicy: retryPolicy() }),
    });
    expect(response).toMatchObject({ status: 200, body: { status: 'failed', error: { code: 'TEXT_TEST_FAILED' }, models: [{ error: { code: 'MODEL_NOT_FOUND' } }] } });
  });

  it('limits concurrent model probes per user and passes a cancellation signal', async () => {
    let finishFirstProbe;
    const probe = vi.fn()
      .mockImplementationOnce((_options) => new Promise((resolve) => { finishFirstProbe = resolve; }))
      .mockResolvedValue({ ok: true });
    const { request } = await createOnboardingApp({ probe });
    const body = JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['model-a'], retryPolicy: retryPolicy() });
    const first = request('/api/v1/model-connection-tests', { method: 'POST', headers: { 'x-user': 'busy-user' }, body });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const signal = probe.mock.calls[0][0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    const limited = await request('/api/v1/model-connection-tests', { method: 'POST', headers: { 'x-user': 'busy-user' }, body });
    expect(limited).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });

    finishFirstProbe({ ok: true });
    expect((await first).status).toBe(200);
    expect(signal.aborted).toBe(false);
  });

  it('cancels model probes and releases their slot when the client disconnects', async () => {
    let probeSignal;
    const probe = vi.fn()
      .mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
        probeSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }))
      .mockResolvedValue({ ok: true });
    const { app, request } = await createOnboardingApp({ probe });
    const body = JSON.stringify({ providerId: 'openai', apiKey: 'key', models: ['model-a'], retryPolicy: retryPolicy() });
    const server = app.listen(0);
    const client = httpRequest({
      hostname: '127.0.0.1', port: server.address().port, path: '/api/v1/model-connection-tests', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-user': 'disconnecting-user' },
    });
    client.on('error', () => undefined);
    client.end(body);
    await vi.waitFor(() => expect(probeSignal).toBeInstanceOf(AbortSignal));

    client.destroy();

    await vi.waitFor(() => expect(probeSignal.aborted).toBe(true));
    await new Promise((resolve) => server.close(resolve));
    expect(probeSignal.aborted).toBe(true);
    const retry = await request('/api/v1/model-connection-tests', {
      method: 'POST', headers: { 'x-user': 'disconnecting-user' }, body,
    });
    expect(retry.status).toBe(200);
  });

  it('rejects githubUrl for existing workspaces', async () => {
    const { request } = await createOnboardingApp();
    const response = await request('/api/v1/workspaces', {
      method: 'POST', body: JSON.stringify({ type: 'existing', path: '/tmp/workspace', githubUrl: 'https://github.com/openbmb/PilotDeck.git' }),
    });
    expect(response).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });

  it('rejects an empty model configuration ID', async () => {
    const { request } = await createOnboardingApp();
    const response = await request('/api/v1/workspaces', {
      method: 'POST', body: JSON.stringify({ type: 'existing', path: '/tmp/workspace', modelConfigurationId: '' }),
    });
    expect(response).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });

  it('rejects invalid githubUrl before creating the workspace directory', async () => {
    const fs = (await import('fs')).promises;
    const mkdir = vi.spyOn(fs, 'mkdir');
    const { request } = await createOnboardingApp();
    const response = await request('/api/v1/workspaces', {
      method: 'POST', body: JSON.stringify({ type: 'new', path: '/tmp/onboarding-invalid-url', githubUrl: 'file:///tmp/repository' }),
    });
    expect(response).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(mkdir).not.toHaveBeenCalled();
    mkdir.mockRestore();
  });

  it('requires the saved API key to match the credential used for testing', async () => {
    const { request } = await createOnboardingApp({ probe: vi.fn().mockResolvedValue({ ok: true }) });
    const test = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'openai', apiKey: 'tested-key', models: ['model-a'], retryPolicy: retryPolicy() }),
    });
    const response = await request('/api/v1/model-configuration', {
      method: 'PUT', body: JSON.stringify({ testId: test.body.testId, providerId: 'openai', apiKey: 'different-key', models: [{ modelId: 'model-a', textInput: true, imageInput: true }], retryPolicy: retryPolicy() }),
    });
    expect(response).toMatchObject({ status: 409, body: { code: 'CONFIGURATION_MISMATCH' } });
  });

  it('creates existing and new workspaces through the shared helpers', async () => {
    const validateWorkspacePath = vi.fn(async (requestedPath) => ({ valid: true, resolvedPath: `/resolved${requestedPath}` }));
    const addProjectManually = vi.fn(async (workspacePath) => ({ name: 'project-id', path: workspacePath }));
    const fsStat = vi.spyOn((await import('fs')).promises, 'stat').mockResolvedValue({ isDirectory: () => true });
    const fsAccess = vi.spyOn((await import('fs')).promises, 'access').mockResolvedValue(undefined);
    const { request } = await createOnboardingApp({ validateWorkspacePath, addProjectManually });
    const result = await request('/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ type: 'existing', path: '/project' }) });
    expect(result).toEqual({ status: 201, body: { id: 'project-id', type: 'existing', path: '/resolved/project', status: 'ready' } });
    fsStat.mockRestore();
    fsAccess.mockRestore();
  });

  it('expires a test record instead of allowing its manual update', async () => {
    const { request, tests } = await createOnboardingApp({ probe: vi.fn().mockResolvedValue({ ok: true }) });
    const result = await request('/api/v1/model-connection-tests', {
      method: 'POST', body: JSON.stringify({ providerId: 'ollama', apiKey: '', models: ['local'], retryPolicy: retryPolicy() }),
    });
    tests.get(result.body.testId).expiresAt = Date.now() - 1;
    const expired = await request(`/api/v1/model-connection-tests/${result.body.testId}/image-capabilities`, {
      method: 'PUT', body: JSON.stringify({ models: [{ modelId: 'local', imageInput: 'supported' }] }),
    });
    expect(expired).toMatchObject({ status: 410, body: { code: 'TEST_EXPIRED' } });
  });

  it('removes only its unique staging directory when cloning a new workspace fails', async () => {
    const fs = (await import('fs')).promises;
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const access = vi.spyOn(fs, 'access').mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const rm = vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    const open = vi.spyOn(fs, 'open').mockResolvedValue({ close: vi.fn(async () => undefined) });
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    const cloneGitHubRepository = vi.fn().mockRejectedValue(new Error('clone failed'));
    const { request } = await createOnboardingApp({
      validateWorkspacePath: vi.fn(async () => ({ valid: true, resolvedPath: '/tmp/onboarding-workspace' })),
      cloneGitHubRepository,
    });
    const response = await request('/api/v1/workspaces', {
      method: 'POST', body: JSON.stringify({ type: 'new', path: '/tmp/onboarding-workspace', githubUrl: 'https://github.com/openbmb/PilotDeck.git' }),
    });
    expect(response).toMatchObject({ status: 409, body: { code: 'GIT_CLONE_FAILED' } });
    expect(cloneGitHubRepository).toHaveBeenCalledWith(
      'https://github.com/openbmb/PilotDeck.git',
      expect.stringMatching(/^\/tmp\/onboarding-workspace\/\.PilotDeck\.pilotdeck-clone-/),
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 300000 }),
    );
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/onboarding-workspace\/\.PilotDeck\.pilotdeck-clone-/), { recursive: true, force: true });
    mkdir.mockRestore();
    access.mockRestore();
    rm.mockRestore();
    open.mockRestore();
    unlink.mockRestore();
  });

  it('limits concurrent workspace clones per user', async () => {
    const fs = (await import('fs')).promises;
    const mkdir = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const stat = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const access = vi.spyOn(fs, 'access').mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const open = vi.spyOn(fs, 'open').mockResolvedValue({ close: vi.fn(async () => undefined) });
    const rename = vi.spyOn(fs, 'rename').mockResolvedValue(undefined);
    const unlink = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    let finishClone;
    const cloneGitHubRepository = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishClone = resolve; }));
    const { request } = await createOnboardingApp({ cloneGitHubRepository });
    const first = request('/api/v1/workspaces', {
      method: 'POST', headers: { 'x-user': 'busy-user' }, body: JSON.stringify({ type: 'new', path: '/tmp/first-workspace', githubUrl: 'https://github.com/openbmb/PilotDeck.git' }),
    });
    await vi.waitFor(() => expect(cloneGitHubRepository).toHaveBeenCalledTimes(1));

    const limited = await request('/api/v1/workspaces', {
      method: 'POST', headers: { 'x-user': 'busy-user' }, body: JSON.stringify({ type: 'new', path: '/tmp/second-workspace', githubUrl: 'https://github.com/openbmb/another.git' }),
    });
    expect(limited).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });

    finishClone();
    expect((await first).status).toBe(201);
    mkdir.mockRestore();
    stat.mockRestore();
    access.mockRestore();
    open.mockRestore();
    rename.mockRestore();
    unlink.mockRestore();
  });
});

async function createOnboardingApp(overrides = {}) {
  const probe = overrides.probe ?? vi.fn();
  const writePilotDeckConfig = overrides.writePilotDeckConfig ?? vi.fn(async (config) => ({ config }));
  const config = overrides.config ?? { schemaVersion: 1, agent: {}, model: { providers: {} }, webui: {} };
  vi.doMock('../services/modelConnectionProbe.js', () => ({ probeModelConnection: probe }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => ({ config })),
    withPilotDeckConfigWrite: vi.fn(async (operation) => operation()),
    writePilotDeckConfig,
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({ reloadPilotDeckConfig: vi.fn(async () => undefined) }));
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({ suppressNextWatchEvent: vi.fn() }));
  vi.doMock('../projects.js', () => ({ addProjectManually: overrides.addProjectManually ?? vi.fn(async (workspacePath) => ({ name: 'id', path: workspacePath })) }));
  vi.doMock('./projects.js', () => ({
    validateWorkspacePath: overrides.validateWorkspacePath ?? vi.fn(async (workspacePath) => ({ valid: true, resolvedPath: workspacePath })),
    cloneGitHubRepository: overrides.cloneGitHubRepository ?? vi.fn(async () => undefined),
  }));
  const onboardingModule = await import('./onboarding.js');
  const routes = onboardingModule.default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: req.headers['x-user'] || 'one' }; next(); });
  app.use('/api/v1', routes);
  return { app, request: (url, init = {}) => requestStatusJson(app, url, init), tests: onboardingModule.tests };
}

function retryPolicy() {
  return { maxRetries: 2, maxStreamRetries: 3, streamIdleTimeoutMs: 30000, baseDelayMs: 1000, maxDelayMs: 60000 };
}

async function requestStatusJson(app, url, init) {
  const server = app.listen(0);
  try {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${url}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
