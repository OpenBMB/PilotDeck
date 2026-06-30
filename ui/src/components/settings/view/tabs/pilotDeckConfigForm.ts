type Path = readonly (string | number)[];

type CronConfigShape = {
  cron?: {
    enabled?: boolean;
  };
};

export type WebSearchTestStatus = 'idle' | 'testing' | 'success' | 'error';

const MASK = '********';

export function patch<T>(config: T, path: Path, value: unknown): T {
  // Immutable deep set. Each key cloned along the way so React picks up the
  // change. Numeric segments materialise arrays; everything else materialises
  // objects.
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const isArrayKey = typeof head === 'number';
  const current: any = config ?? (isArrayKey ? [] : {});
  const next: any = isArrayKey ? [...(current as unknown[])] : { ...(current as object) };
  next[head as string | number] = rest.length === 0
    ? value
    : patch(
        current?.[head as string | number] ?? (typeof rest[0] === 'number' ? [] : {}),
        rest,
        value,
      );
  return next as T;
}

export function isCronConfigEnabled(config: CronConfigShape): boolean {
  return config.cron !== undefined && config.cron.enabled !== false;
}

export function isMaskedSecret(value: string | undefined): boolean {
  return value === MASK;
}

export function hasUsableSecret(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return Boolean(trimmed) && !isMaskedSecret(trimmed) && trimmed !== 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE' && !trimmed.startsWith('PLACEHOLDER_');
}

export function getWebSearchTestApiKey(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return hasUsableSecret(value) ? trimmed : '';
}

export function isWebSearchTestDisabled(status: WebSearchTestStatus): boolean {
  return status === 'testing';
}

export function isMissingWebSearchCredentialError(error: unknown): boolean {
  return typeof error === 'string' && error.trim() === 'API key is required.';
}
