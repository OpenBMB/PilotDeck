import type { TFunction } from 'i18next';

function routeName(value: string, t: TFunction): string {
  if (value === "default") return t('common:modelUsage.defaultRoute');
  return value.replace(/[_-]/g, " ");
}

export function usageLabel(path: string, t: TFunction): string {
  if (path === "agent.model") return t('common:modelUsage.primaryModel');
  if (path === "agent.subagents.default") return t('common:modelUsage.subagentModel');
  const profile = /^agent\.subagents\.profiles\.([^.]+)\.model$/.exec(path);
  if (profile) return t('common:modelUsage.subagentProfileModel', { profile: profile[1] });
  if (path === "memory.model") return t('common:modelUsage.memoryModel');

  const scenario = /^router\.scenarios\.([^.]+)$/.exec(path);
  if (scenario) return t('common:modelUsage.preferred', { route: routeName(scenario[1], t) });

  const fallback = /^router\.fallback\.([^.]+)\.\d+$/.exec(path);
  if (fallback) return t('common:modelUsage.fallback', { route: routeName(fallback[1], t) });

  if (path === "router.tokenSaver.judge") return t('common:modelUsage.judgeModel');
  const tier = /^router\.tokenSaver\.tiers\.([^.]+)\.model$/.exec(path);
  if (tier) return t('common:modelUsage.tier', { route: routeName(tier[1], t) });
  if (path === "router.stats.baselineModel") return t('common:modelUsage.baselineModel');
  if (path.startsWith("router.stats.modelPricing.")) return t('common:modelUsage.modelPricing');
  return path;
}
