import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { officeBinaryPathExample, readOfficePreviewStatus } from './officePreviewStatus';

vi.mock('./api', () => ({ api: { officePreviewStatus: vi.fn(), pilotDeckConfig: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

it.each([
  ['win32', 'C:\\Program Files\\LibreOffice\\program\\soffice.com'],
  ['darwin', '/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  ['linux', '/usr/bin/soffice'],
])('uses the %s preview host for the executable example', async (platform, expected) => {
  vi.mocked(api.officePreviewStatus).mockResolvedValue(new Response(JSON.stringify({ service: 'libreoffice', platform })));
  const status = await readOfficePreviewStatus();
  expect(officeBinaryPathExample(status.platform)).toBe(expected);
});

it('uses a generic hint when an older server omits the platform', async () => {
  vi.mocked(api.officePreviewStatus).mockResolvedValue(new Response(JSON.stringify({ service: 'builtin' })));
  const status = await readOfficePreviewStatus();
  expect(officeBinaryPathExample(status.platform)).toBeUndefined();
  expect(officeBinaryPathExample('unknown')).toBeUndefined();
});

it('preserves configured values without assuming an OS when detection fails', async () => {
  vi.mocked(api.officePreviewStatus).mockResolvedValue(new Response('unavailable', { status: 503 }));
  vi.mocked(api.pilotDeckConfig).mockResolvedValue(new Response(JSON.stringify({ config: {
    webui: { officePreview: { service: 'libreoffice', binaryPath: '/custom/soffice' } },
  } })));
  const status = await readOfficePreviewStatus();
  expect(status).toMatchObject({ service: 'libreoffice', configuredBinaryPath: '/custom/soffice', statusUnavailable: true });
  expect(officeBinaryPathExample(status.platform)).toBeUndefined();
});
