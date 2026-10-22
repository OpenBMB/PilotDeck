import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePilotHome } from "../../pilot/paths.js";
import { networkFetch } from "../../network/fetch.js";
import { CATALOG_GENERATED_AT } from "./bundled.generated.js";
import { PROVIDER_CATALOG } from "./providers.js";
import { CATALOG_SOURCES, mergeCatalog, normalizeCatalogSource, validateCatalog, type CatalogOverlay, type CatalogSource } from "./sources.js";
import type { ProviderCatalog } from "./types.js";

export const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
type Env = Record<string, string | undefined>;
type SourceCache = { checkedAt: number; updatedAt: number; etag?: string; models: CatalogOverlay };
type Cache = { version: 1; sources: Partial<Record<CatalogSource, SourceCache>> };
export type CatalogSnapshot = { catalog: ProviderCatalog; updatedAt: number | null; errors: Record<string, string> };
type PendingRefresh = { force: boolean; promise: Promise<CatalogSnapshot> };
const pending = new Map<string, PendingRefresh>();
const snapshots = new Map<string, { stamp: string; cache: Cache }>();

export function getCatalogCachePath(env: Env = process.env): string {
  return join(resolvePilotHome(env), "cache", "model-catalog.json");
}

function readCache(path: string): Cache {
  try {
    const stat = statSync(path);
    if (stat.size > MAX_BYTES) return { version: 1, sources: {} };
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const known = snapshots.get(path);
    if (known?.stamp === stamp) return known.cache;
    const cache = JSON.parse(readFileSync(path, "utf8")) as Cache;
    if (cache.version !== 1 || !cache.sources || typeof cache.sources !== "object") throw new Error("Invalid catalog cache");
    for (const source of Object.keys(CATALOG_SOURCES) as CatalogSource[]) {
      const entry = cache.sources[source];
      if (!entry) continue;
      if (!Number.isFinite(entry.checkedAt) || !Number.isFinite(entry.updatedAt) || !entry.models || typeof entry.models !== "object") throw new Error("Invalid catalog cache entry");
      validateCatalog(mergeCatalog(PROVIDER_CATALOG, entry.models));
    }
    if (snapshots.size >= 8) snapshots.clear();
    snapshots.set(path, { stamp, cache });
    return cache;
  } catch {
    // A missing or damaged cache never prevents offline startup.
    return { version: 1, sources: {} };
  }
}

function snapshot(cache: Cache, errors: Record<string, string> = {}): CatalogSnapshot {
  let catalog = PROVIDER_CATALOG;
  let updatedAt: number | null = null;
  for (const source of Object.keys(CATALOG_SOURCES) as CatalogSource[]) {
    const entry = cache.sources[source];
    if (!entry || entry.updatedAt < CATALOG_GENERATED_AT) continue;
    catalog = mergeCatalog(catalog, entry.models);
    updatedAt = Math.max(updatedAt ?? 0, entry.updatedAt);
  }
  return { catalog, updatedAt, errors };
}

/** Synchronous, offline read for config parsing and first paint. */
export function readCatalogSnapshot(env: Env = process.env): CatalogSnapshot {
  return snapshot(readCache(getCatalogCachePath(env)));
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty model catalog response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Model catalog exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Fetches public metadata only. No provider credentials are sent to catalog sources. */
export async function fetchCatalogSource(source: CatalogSource, baseline: ProviderCatalog, options: {
  etag?: string; signal?: AbortSignal; fetchImpl?: typeof fetch;
} = {}): Promise<{ models?: CatalogOverlay; etag?: string }> {
  const timeout = AbortSignal.timeout(12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await networkFetch(CATALOG_SOURCES[source], {
    headers: { accept: "application/json", ...(options.etag ? { "if-none-match": options.etag } : {}) }, signal,
  }, { fetchImpl: options.fetchImpl });
  if (response.status === 304 && options.etag) return { etag: options.etag };
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Catalog source returned HTTP ${response.status}`);
  }
  const models = normalizeCatalogSource(source, await readBoundedJson(response), baseline);
  validateCatalog(mergeCatalog(baseline, models));
  return { models, etag: response.headers.get("etag") ?? undefined };
}

/** Concurrent callers share one refresh; failures retain each source's last good data. */
export function refreshCatalog(options: { env?: Env; force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<CatalogSnapshot> {
  const env = options.env ?? process.env;
  const path = getCatalogCachePath(env);
  if (env.PILOTDECK_MODEL_CATALOG_NETWORK === "0") return Promise.resolve(readCatalogSnapshot(env));
  const active = pending.get(path);
  if (active) {
    if (!options.force || active.force) return active.promise;
    return active.promise.catch(() => undefined).then(() => refreshCatalog(options));
  }
  const operation = (async () => {
    const old = readCache(path);
    const cache: Cache = { version: 1, sources: { ...old.sources } };
    const errors: Record<string, string> = {};
    let changed = false;
    await Promise.all((Object.keys(CATALOG_SOURCES) as CatalogSource[]).map(async source => {
      const entry = old.sources[source];
      if (!options.force && entry && entry.updatedAt >= CATALOG_GENERATED_AT && Date.now() - entry.checkedAt < CATALOG_REFRESH_INTERVAL_MS) return;
      try {
        const fetched = await fetchCatalogSource(source, snapshot(old).catalog, { etag: entry && entry.updatedAt >= CATALOG_GENERATED_AT ? entry.etag : undefined, fetchImpl: options.fetchImpl });
        const now = Date.now();
        const retained = fetched.models ? Object.fromEntries(Object.entries(fetched.models).map(([id, models]) => [id,
          mergeCatalog(snapshot(old).catalog, { [id]: models })[id].models,
        ])) : undefined;
        cache.sources[source] = retained
          ? { checkedAt: now, updatedAt: now, etag: fetched.etag, models: retained }
          : { ...entry!, checkedAt: now };
        changed = true;
      } catch (error) {
        errors[source] = error instanceof Error ? error.message : String(error);
      }
    }));
    if (changed) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
        await rename(temporary, path);
        snapshots.delete(path);
      } catch (error) {
        errors.cache = error instanceof Error ? error.message : String(error);
        return snapshot(old, errors);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return snapshot(cache, errors);
  })();
  let tracked: Promise<CatalogSnapshot>;
  tracked = operation.finally(() => {
    if (pending.get(path)?.promise === tracked) pending.delete(path);
  });
  pending.set(path, { force: options.force === true, promise: tracked });
  return tracked;
}
