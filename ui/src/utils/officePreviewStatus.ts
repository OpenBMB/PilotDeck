import { api } from './api';

export type OfficePreviewService = 'none' | 'libreoffice';

export type OfficePreviewStatus = {
  service: OfficePreviewService;
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

export function normalizeOfficePreviewService(value: unknown): OfficePreviewService {
  return String(value || '').trim().toLowerCase() === 'libreoffice' ? 'libreoffice' : 'none';
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
