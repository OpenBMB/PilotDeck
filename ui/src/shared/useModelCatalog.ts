import { useEffect, useSyncExternalStore } from 'react';
import { authenticatedFetch } from '../utils/api';
import { getCatalogProviders, replaceCatalogProviders, subscribeCatalog, type CatalogProvider } from './catalogProviders';

type PendingCatalogRequest = { force: boolean; promise: Promise<CatalogProvider[]> };
let pending: PendingCatalogRequest | undefined;
let checkedAt = 0;
let attemptedAt = 0;
let lastError = '';

export function getCatalogRefreshError(): string { return lastError; }

export function refreshModelCatalog(force = false): Promise<CatalogProvider[]> {
  if (pending) {
    if (!force || pending.force) return pending.promise;
    return pending.promise.catch(() => undefined).then(() => refreshModelCatalog(true));
  }
  if (!force && Date.now() - checkedAt < 4 * 60 * 60 * 1000) return Promise.resolve(getCatalogProviders());
  if (!force && Date.now() - attemptedAt < 60_000) return Promise.resolve(getCatalogProviders());
  attemptedAt = Date.now();
  const operation = (async () => {
    const signal = AbortSignal.timeout(15_000);
    const apply = async (response: Response) => {
      if (!response.ok) throw new Error('Model catalog could not be refreshed.');
      const data = await response.json();
      if (!Array.isArray(data.providers) || !data.providers.length || data.providers.some((p: CatalogProvider) =>
        !p || typeof p.id !== 'string' || typeof p.defaultUrl !== 'string' || !Array.isArray(p.models))) {
        throw new Error('Invalid model catalog response.');
      }
      lastError = Object.values(data.errors ?? {}).join('; ');
      replaceCatalogProviders(data.providers);
    };
    // Restore the server's cache before waiting on external sources.
    await apply(await authenticatedFetch('/api/config/model-catalog', { signal }));
    await apply(await authenticatedFetch('/api/config/model-catalog', {
      method: 'POST', signal, body: JSON.stringify({ force }),
    }));
    checkedAt = lastError ? 0 : Date.now();
    return getCatalogProviders();
  })().catch(error => {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  });
  let tracked: Promise<CatalogProvider[]>;
  tracked = operation.finally(() => {
    if (pending?.promise === tracked) pending = undefined;
  });
  pending = { force, promise: tracked };
  return tracked;
}

export function useModelCatalog(): CatalogProvider[] {
  const providers = useSyncExternalStore(subscribeCatalog, getCatalogProviders, getCatalogProviders);
  useEffect(() => { void refreshModelCatalog().catch(() => undefined); }, []);
  return providers;
}
