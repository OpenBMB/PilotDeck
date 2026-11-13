// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, authenticatedFetch } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preview request errors', () => {
  it('keeps a preview 500 in the preview area while preserving global toasts for other requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.fn();
    window.addEventListener('pilotdeck:toast', toast);
    try {
      await api.spreadsheetInteractivePreview('project', 'report.xlsx');
      expect(toast).not.toHaveBeenCalled();

      await authenticatedFetch('/api/other-operation');
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('pilotdeck:toast', toast);
    }
  });
});


it('encodes task workspace identity as one file-route parameter', async () => {
  const fetchMock = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  await api.readFile('cron-task:owned', 'report.md');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/cron-task%3Aowned/file?filePath=report.md');
});
