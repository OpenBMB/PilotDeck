import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('MCP config reload', () => {
  it('reloads project extensions after saving project MCP config', async () => {
    const reloadExtensions = vi.fn(async (input) => ({
      reloaded: true,
      changedPaths: input.changedPaths,
    }));
    const { request, writeMcpConfigFile } = await createMcpApp({ reloadExtensions });

    const response = await request('/api/mcp/config/project', {
      method: 'PUT',
      body: JSON.stringify({
        raw: JSON.stringify({ mcpServers: {} }),
        projectPath: '/tmp/project',
      }),
    });

    expect(response.status).toBe(200);
    expect(writeMcpConfigFile).toHaveBeenCalledWith(
      'project',
      JSON.stringify({ mcpServers: {} }),
      '/tmp/project',
    );
    expect(reloadExtensions).toHaveBeenCalledWith({
      projectKey: '/tmp/project',
      changedPaths: ['/tmp/project/.pilotdeck/mcp.json'],
    });
    expect(response.body.reload).toEqual({
      reloaded: true,
      changedPaths: ['/tmp/project/.pilotdeck/mcp.json'],
    });
  });

  it('falls back to config reload for an older Gateway client', async () => {
    const reloadConfig = vi.fn(async () => ({ reloaded: true }));
    const { request } = await createMcpApp({ reloadConfig });

    const response = await request('/api/mcp/config/global', {
      method: 'PUT',
      body: JSON.stringify({ raw: JSON.stringify({ mcpServers: {} }) }),
    });

    expect(response.status).toBe(200);
    expect(reloadConfig).toHaveBeenCalledOnce();
    expect(response.body.reload).toEqual({ reloaded: true });
  });
});

async function createMcpApp(gateway) {
  const writeMcpConfigFile = vi.fn(async (scope, _raw, projectPath) => ({
    path: scope === 'project'
      ? `${projectPath}/.pilotdeck/mcp.json`
      : '/tmp/pilot-home/mcp.json',
    config: { mcpServers: {} },
  }));
  vi.doMock('../services/mcpConfig.js', () => ({
    listMcpConfigFiles: vi.fn(),
    readMcpConfigFile: vi.fn(),
    writeMcpConfigFile,
    normalizeMcpConfig: vi.fn((value) => value),
  }));
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => gateway),
  }));

  const { default: routes } = await import('./mcp.js');
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', routes);

  return {
    writeMcpConfigFile,
    request: (path, init = {}) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
