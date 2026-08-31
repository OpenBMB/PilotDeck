import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upload routes', () => {
  it('does not miss a terminal event emitted while loading the SSE snapshot', async () => {
    const { app, store } = await createUploadsApp();
    const created = uploadRecord('created');
    const completed = uploadRecord('completed');
    let listener;
    const unsubscribe = vi.fn();
    vi.spyOn(store, 'subscribe').mockImplementation((_uploadId, next) => {
      listener = next;
      return unsubscribe;
    });
    vi.spyOn(store, 'get').mockImplementation(async () => {
      listener(completed);
      return created;
    });

    const response = await request(app, '/api/uploads/upload-1/events');

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: upload_completed');
    expect(response.text).toContain('"status":"completed"');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('returns 204 with no response body when an upload is cancelled', async () => {
    const { app, store } = await createUploadsApp();
    vi.spyOn(store, 'cancel').mockResolvedValue(uploadRecord('cancelled'));

    const response = await request(app, '/api/uploads/upload-1', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it.each([
    ['PROJECT_PATH_FORBIDDEN', 403],
    ['ATTACHMENT_EXPIRED', 410],
    ['UPLOAD_NOT_COMPLETED', 409],
  ])('maps %s to HTTP %i', async (code, status) => {
    const { app, store } = await createUploadsApp();
    vi.spyOn(store, 'get').mockRejectedValue(Object.assign(new Error(code), { code }));

    const response = await request(app, '/api/uploads/upload-1');

    expect(response.status).toBe(status);
    expect(JSON.parse(response.text).error.code).toBe(code);
  });
});

async function createUploadsApp() {
  const { default: routes, uploadStore } = await import('./uploads.js');
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', routes);
  return { app, store: uploadStore };
}

function uploadRecord(status) {
  return {
    uploadId: 'upload-1',
    projectKey: '/project',
    status,
    manifest: [],
    totalBytes: 1,
    uploadedBytes: status === 'completed' ? 1 : 0,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-08-12T00:00:00.000Z',
  };
}

async function request(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
