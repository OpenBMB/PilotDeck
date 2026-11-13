// Extracted without semantic changes from frontend-enterprise/src/api/client.ts.
export class ApiError extends Error {
  status: number;
  body: string;
  code?: string;

  constructor(status: number, body: string, statusText: string) {
    const parsed = parseErrorPayload(body);
    const html = /<(?:!doctype|html|head|body)[\s>]/i.test(parsed.message);
    super(html ? `服务暂时不可用，请稍后重试 (HTTP ${status})` : parsed.message || statusText || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = html ? 'UPSTREAM_INVALID_RESPONSE' : parsed.code;
  }
}

type ParsedApiError = {
  message: string;
  code?: string;
};

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

function stableErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && STABLE_ERROR_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

function parseErrorPayload(text: string): ParsedApiError {
  if (!text) return { message: '' };
  try {
    const payload = JSON.parse(text) as {
      code?: unknown;
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const detail = payload.detail ?? payload.message ?? payload.error;
    const topLevelCode = stableErrorCode(payload.code);
    if (typeof detail === 'string') {
      return { message: detail, code: topLevelCode ?? stableErrorCode(detail) };
    }
    if (Array.isArray(detail)) {
      return {
        message: detail
          .map(formatValidationDetail)
          .filter(Boolean)
          .join('；'),
        code: topLevelCode,
      };
    }
    if (detail && typeof detail === 'object') {
      const structured = detail as { code?: unknown; message?: unknown; detail?: unknown };
      const message = typeof structured.message === 'string'
        ? structured.message
        : typeof structured.detail === 'string'
          ? structured.detail
          : '';
      const code = stableErrorCode(structured.code) ?? topLevelCode;
      if (message || code) return { message: message || String(code), code };
    }
  } catch {
    return { message: text };
  }
  return { message: text };
}

function formatValidationDetail(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';

  const detail = item as { loc?: unknown; msg?: unknown };
  const message = typeof detail.msg === 'string' ? detail.msg : '';
  const location = Array.isArray(detail.loc)
    ? detail.loc.map((part) => String(part)).filter(Boolean).join('.')
    : '';

  if (location && message) return `${location}: ${message}`;
  return message;
}
