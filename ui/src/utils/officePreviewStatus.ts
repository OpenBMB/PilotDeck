import { api } from './api';

export type OfficePreviewService = 'builtin' | 'libreoffice';

export type OfficePreviewStatus = {
  service: OfficePreviewService;
  platform?: string;
  configuredBinaryPath?: string;
  libreOffice?: {
    available?: boolean;
    binaryPath?: string | null;
    version?: string;
    candidates?: Array<{
      binaryPath: string;
      available: boolean;
      version?: string;
      error?: string;
    }>;
  };
  statusError?: string;
  statusUnavailable?: boolean;
};

// Use the preview host, which may differ from the browser's operating system.
export function officeBinaryPathExample(platform?: string): string | undefined {
  switch (platform) {
    case 'win32': return 'C:\\Program Files\\LibreOffice\\program\\soffice.com';
    case 'darwin': return '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    case 'linux': return '/usr/bin/soffice';
    default: return undefined;
  }
}

export function normalizeOfficePreviewService(value: unknown): OfficePreviewService {
  return String(value || '').trim().toLowerCase() === 'libreoffice' ? 'libreoffice' : 'builtin';
}

export function officePreviewRendererSignature(
  service: unknown,
  binaryPath: unknown,
): string {
  return JSON.stringify([
    normalizeOfficePreviewService(service),
    String(binaryPath || '').trim(),
  ]);
}

export function officePreviewRendererSignatureFromConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const webui = (config as { webui?: unknown }).webui;
  if (!webui || typeof webui !== 'object' || Array.isArray(webui)) return null;
  const officePreview = (webui as { officePreview?: unknown }).officePreview;
  if (!officePreview || typeof officePreview !== 'object' || Array.isArray(officePreview)) return null;
  const value = officePreview as { service?: unknown; binaryPath?: unknown };
  return officePreviewRendererSignature(value.service, value.binaryPath);
}

async function readJsonBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      response.ok
        ? 'Expected JSON response for Office preview status.'
        : text.slice(0, 160),
    );
  }
}

async function readServiceFromConfig(): Promise<OfficePreviewStatus> {
  const response = await api.pilotDeckConfig();
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return {
    service: normalizeOfficePreviewService(body?.config?.webui?.officePreview?.service),
    configuredBinaryPath: String(body?.config?.webui?.officePreview?.binaryPath || '').trim(),
  };
}

export async function readOfficePreviewStatus(options: { refresh?: boolean } = {}): Promise<OfficePreviewStatus> {
  try {
    const response = await api.officePreviewStatus({ refresh: options.refresh });
    const body = await readJsonBody(response);
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return {
      service: normalizeOfficePreviewService(body?.service),
      platform: typeof body?.platform === 'string' ? body.platform : undefined,
      configuredBinaryPath: String(body?.configuredBinaryPath || '').trim(),
      libreOffice: body?.libreOffice,
    };
  } catch {
    const fallback = await readServiceFromConfig();
    return {
      ...fallback,
      statusUnavailable: true,
    };
  }
}
