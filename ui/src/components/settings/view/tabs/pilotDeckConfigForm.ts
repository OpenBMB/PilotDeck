type Path = readonly (string | number)[];

type CronConfigShape = {
  cron?: {
    enabled?: boolean;
  };
};

type ProviderRefConfig = {
  agent?: {
    model?: string;
    subagents?: {
      default?: string;
    };
  };
  memory?: {
    model?: string;
    llm?: unknown;
  };
  router?: {
    scenarios?: Record<string, string>;
    fallback?: Record<string, string[]>;
    tokenSaver?: {
      judge?: string;
      tiers?: Record<string, { model?: string }>;
    };
    autoOrchestrate?: {
      mainAgentModel?: string;
      subagentModel?: string;
    };
  };
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

function rewriteProviderRef(value: unknown, oldProviderId: string, newProviderId: string): unknown {
  const oldPrefix = `${oldProviderId}/`;
  if (typeof value !== 'string' || !value.startsWith(oldPrefix)) return value;
  return `${newProviderId}/${value.slice(oldPrefix.length)}`;
}

export function rewriteProviderRefs<T extends ProviderRefConfig>(config: T, oldProviderId: string, newProviderId: string): T {
  let next = config;

  const agentModel = rewriteProviderRef(next.agent?.model, oldProviderId, newProviderId);
  if (agentModel !== next.agent?.model) {
    next = patch(next, ['agent', 'model'], agentModel);
  }

  const subagentDefault = rewriteProviderRef(next.agent?.subagents?.default, oldProviderId, newProviderId);
  if (subagentDefault !== next.agent?.subagents?.default) {
    next = patch(next, ['agent', 'subagents', 'default'], subagentDefault);
  }

  const memoryModel = rewriteProviderRef(next.memory?.model, oldProviderId, newProviderId);
  if (memoryModel !== next.memory?.model) {
    next = patch(next, ['memory', 'model'], memoryModel);
  }

  const memoryLlm = next.memory?.llm;
  if (memoryLlm && typeof memoryLlm === 'object' && !Array.isArray(memoryLlm)) {
    const llm = memoryLlm as Record<string, unknown>;
    if (llm.provider === oldProviderId) {
      next = patch(next, ['memory', 'llm', 'provider'], newProviderId);
    }
  }

  const scenarios = next.router?.scenarios;
  if (scenarios) {
    const rewritten = Object.fromEntries(
      Object.entries(scenarios).map(([key, ref]) => [key, rewriteProviderRef(ref, oldProviderId, newProviderId) as string]),
    );
    if (Object.entries(scenarios).some(([key, ref]) => rewritten[key] !== ref)) {
      next = patch(next, ['router', 'scenarios'], rewritten);
    }
  }

  const fallback = next.router?.fallback;
  if (fallback) {
    const rewritten = Object.fromEntries(
      Object.entries(fallback).map(([key, refs]) => [
        key,
        refs.map((ref) => rewriteProviderRef(ref, oldProviderId, newProviderId) as string),
      ]),
    );
    if (Object.entries(fallback).some(([key, refs]) => rewritten[key].some((ref, index) => ref !== refs[index]))) {
      next = patch(next, ['router', 'fallback'], rewritten);
    }
  }

  const judge = rewriteProviderRef(next.router?.tokenSaver?.judge, oldProviderId, newProviderId);
  if (judge !== next.router?.tokenSaver?.judge) {
    next = patch(next, ['router', 'tokenSaver', 'judge'], judge);
  }

  const tiers = next.router?.tokenSaver?.tiers;
  if (tiers) {
    const rewritten = Object.fromEntries(
      Object.entries(tiers).map(([key, tier]) => [
        key,
        {
          ...tier,
          model: rewriteProviderRef(tier.model, oldProviderId, newProviderId) as string | undefined,
        },
      ]),
    );
    if (Object.entries(tiers).some(([key, tier]) => rewritten[key].model !== tier.model)) {
      next = patch(next, ['router', 'tokenSaver', 'tiers'], rewritten);
    }
  }

  const mainAgentModel = rewriteProviderRef(next.router?.autoOrchestrate?.mainAgentModel, oldProviderId, newProviderId);
  if (mainAgentModel !== next.router?.autoOrchestrate?.mainAgentModel) {
    next = patch(next, ['router', 'autoOrchestrate', 'mainAgentModel'], mainAgentModel);
  }

  const subagentModel = rewriteProviderRef(next.router?.autoOrchestrate?.subagentModel, oldProviderId, newProviderId);
  if (subagentModel !== next.router?.autoOrchestrate?.subagentModel) {
    next = patch(next, ['router', 'autoOrchestrate', 'subagentModel'], subagentModel);
  }

  return next;
}
