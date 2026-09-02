import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import { hasUsableSecret, isMaskedSecret } from "./providerRefs";
import type { V2Provider } from "../types";

export function countEnabledModels(provider: V2Provider): number {
  return Object.keys(provider.models ?? {}).length;
}

export function providerHasCredential(
  provider: V2Provider,
  catalogEntry?: CatalogProvider,
): boolean {
  if (catalogEntry?.requiresApiKey === false) return true;
  const key = provider.apiKey;
  return isMaskedSecret(key) || hasUsableSecret(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function modelHasPassingConnectionTest(model: unknown): boolean {
  if (!isRecord(model)) return false;
  const test = model.connectionTest;
  if (!isRecord(test)) return false;
  return test.status === "passed"
    && test.textInput === "supported"
    && (test.imageInput === "supported" || test.imageInput === "unsupported");
}

export function isProviderConnected(provider: V2Provider): boolean {
  const models = provider.models ?? {};
  const ids = Object.keys(models);
  if (ids.length === 0) return false;
  return ids.every((id) => modelHasPassingConnectionTest(models[id]));
}

export function isProviderPending(provider: V2Provider): boolean {
  return !isProviderConnected(provider);
}

export function clearProviderConnectionTests(provider: V2Provider): V2Provider {
  const models = provider.models ?? {};
  const nextModels: NonNullable<V2Provider["models"]> = {};
  for (const [id, model] of Object.entries(models)) {
    if (!isRecord(model) || !("connectionTest" in model)) {
      nextModels[id] = model;
      continue;
    }
    const { connectionTest: _ignored, ...rest } = model;
    nextModels[id] = rest;
  }
  return { ...provider, models: nextModels };
}
