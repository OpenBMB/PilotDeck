import { findCatalogProviderById } from "../../../../../shared/catalogProviders";
import { patch } from "./patch";
import type { PilotDeckConfig } from "../types";

export function splitModelRef(
  ref: string | undefined,
): { providerId: string; modelId: string } | null {
  const value = ref?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function ensureModelRefConfigured<T extends PilotDeckConfig>(
  config: T,
  ref: string | undefined,
): T {
  const parsed = splitModelRef(ref);
  if (!parsed) return config;

  const provider = config.model?.providers?.[parsed.providerId];
  if (!provider) return config;
  if (
    provider.models &&
    Object.prototype.hasOwnProperty.call(provider.models, parsed.modelId)
  ) {
    return config;
  }

  return patch(
    config,
    ["model", "providers", parsed.providerId, "models", parsed.modelId],
    {},
  );
}

export function buildModelRefOptions(
  config: PilotDeckConfig,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const providers = config.model?.providers ?? {};
  for (const [pid, prov] of Object.entries(providers)) {
    const catalog = findCatalogProviderById(pid);
    const seen = new Set<string>();

    if (catalog) {
      for (const model of catalog.models) {
        seen.add(model.id);
        out.push({
          value: `${pid}/${model.id}`,
          label: `${catalog.displayName}: ${model.displayName}`,
        });
      }
    }

    for (const mid of Object.keys(prov.models ?? {})) {
      if (seen.has(mid)) continue;
      out.push({
        value: `${pid}/${mid}`,
        label: catalog ? `${catalog.displayName}: ${mid}` : `${pid}/${mid}`,
      });
    }
  }
  return out;
}
