import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import type { PilotDeckConfig } from "../types";
import { patch } from "./patch";

const MASK = "********";

function rewriteProviderRef(
  value: unknown,
  oldProviderId: string,
  newProviderId: string,
): unknown {
  const oldPrefix = `${oldProviderId}/`;
  if (typeof value !== "string" || !value.startsWith(oldPrefix)) return value;
  return `${newProviderId}/${value.slice(oldPrefix.length)}`;
}

export function rewriteProviderRefs(
  config: PilotDeckConfig,
  oldProviderId: string,
  newProviderId: string,
): PilotDeckConfig {
  let next = config;

  const agentModel = rewriteProviderRef(
    next.agent?.model,
    oldProviderId,
    newProviderId,
  );
  if (agentModel !== next.agent?.model) {
    next = patch(next, ["agent", "model"], agentModel);
  }

  const subagentDefault = rewriteProviderRef(
    next.agent?.subagents?.default,
    oldProviderId,
    newProviderId,
  );
  if (subagentDefault !== next.agent?.subagents?.default) {
    next = patch(next, ["agent", "subagents", "default"], subagentDefault);
  }

  const memoryModel = rewriteProviderRef(
    next.memory?.model,
    oldProviderId,
    newProviderId,
  );
  if (memoryModel !== next.memory?.model) {
    next = patch(next, ["memory", "model"], memoryModel);
  }

  const scenarios = next.router?.scenarios;
  if (scenarios) {
    const rewritten = Object.fromEntries(
      Object.entries(scenarios).map(([key, value]) => [
        key,
        rewriteProviderRef(value, oldProviderId, newProviderId) as string,
      ]),
    );
    if (
      Object.entries(scenarios).some(([key, value]) => rewritten[key] !== value)
    ) {
      next = patch(next, ["router", "scenarios"], rewritten);
    }
  }

  const fallback = next.router?.fallback;
  if (fallback) {
    const rewritten = Object.fromEntries(
      Object.entries(fallback).map(([key, refs]) => [
        key,
        refs.map((ref) =>
          rewriteProviderRef(ref, oldProviderId, newProviderId),
        ) as string[],
      ]),
    );
    if (
      Object.entries(fallback).some(
        ([key, refs]) =>
          refs.length !== rewritten[key].length ||
          refs.some((ref, idx) => rewritten[key][idx] !== ref),
      )
    ) {
      next = patch(next, ["router", "fallback"], rewritten);
    }
  }

  const judge = rewriteProviderRef(
    next.router?.tokenSaver?.judge,
    oldProviderId,
    newProviderId,
  );
  if (judge !== next.router?.tokenSaver?.judge) {
    next = patch(next, ["router", "tokenSaver", "judge"], judge);
  }

  const tiers = next.router?.tokenSaver?.tiers;
  if (tiers) {
    const rewritten = Object.fromEntries(
      Object.entries(tiers).map(([key, tier]) => [
        key,
        {
          ...tier,
          model: rewriteProviderRef(
            tier.model,
            oldProviderId,
            newProviderId,
          ) as string | undefined,
        },
      ]),
    );
    if (
      Object.entries(tiers).some(
        ([key, tier]) => rewritten[key].model !== tier.model,
      )
    ) {
      next = patch(next, ["router", "tokenSaver", "tiers"], rewritten);
    }
  }

  return next;
}

export function isMaskedSecret(value: string | undefined): boolean {
  return value === MASK;
}

export function hasUsableSecret(value: string | undefined): boolean {
  const shown = secretDisplayValue(value).trim();
  return shown.length > 0;
}

export function secretDisplayValue(value: string | undefined): string {
  if (!value) return "";
  if (isMaskedSecret(value)) return "";
  if (value === "PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE") return "";
  if (value.startsWith("PLACEHOLDER_")) return "";
  return value;
}

export function providerDisplayName(
  providerId: string,
  catalogEntry?: CatalogProvider,
  emptyFallback = "Custom Provider",
): string {
  if (catalogEntry?.displayName) return catalogEntry.displayName;
  const normalized = providerId.trim();
  if (!normalized) return emptyFallback;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
