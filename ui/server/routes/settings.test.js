import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('attachment upload limits settings route', () => {
  it('returns the shared configured limit without user-specific data', async () => {
    const { request } = await createSettingsApp({
      maxFileSizeMB: 100,
      maxFileSizeBytes: 100 * 1024 * 1024,
      maxAttachments: 10,
    });

    const response = await request('/api/settings/attachment-upload-limits');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      maxFileSizeMB: 100,
      maxFileSizeBytes: 100 * 1024 * 1024,
      maxAttachments: 10,
    });
  });
});

async function createSettingsApp(limits) {
  vi.doMock('../database/db.js', () => ({
    apiKeysDb: {},
    credentialsDb: {},
    notificationPreferencesDb: {},
    pushSubscriptionsDb: {},
  }));
  vi.doMock('../services/vapid-keys.js', () => ({ getPublicKey: vi.fn() }));
  vi.doMock('../services/notification-orchestrator.js', () => ({
    createNotificationEvent: vi.fn(),
    notifyUserIfEnabled: vi.fn(),
  }));
  vi.doMock('../services/permissionSettings.js', () => ({
    readPermissionSettings: vi.fn(),
    writePermissionSettings: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => ({ config: {} })),
    getChatAttachmentLimits: vi.fn(() => limits),
  }));

  const { default: settingsRoutes } = await import('./settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);

  return {
    request: (path, init = {}) => requestStatusJson(app, path, init),
  };
}

async function requestStatusJson(app, path, init) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, init);
    return {
      status: response.status,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
