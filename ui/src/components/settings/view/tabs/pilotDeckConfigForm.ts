type Path = readonly (string | number)[];

type CronConfigShape = {
  cron?: {
    enabled?: boolean;
  };
};

type WebSearchProvider = 'glm' | 'tavily' | 'custom';

type WebSearchConfigShape = {
  enabled?: boolean;
};

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

export function webSearchConfigForProvider(
  current: WebSearchConfigShape,
  provider: WebSearchProvider,
  glmDefaultEndpoint: string,
): WebSearchConfigShape & { provider: WebSearchProvider; endpoint?: string } {
  return {
    ...(current.enabled === undefined ? {} : { enabled: current.enabled }),
    provider,
    ...(provider === 'glm' ? { endpoint: glmDefaultEndpoint } : {}),
  };
}
