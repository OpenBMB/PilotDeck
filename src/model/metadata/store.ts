import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePilotHome } from "../../pilot/paths.js";
import type { ModelProtocol } from "../protocol/canonical.js";
import { normalizeProviderTokenLimits, type ProviderModelMetadata, type TokenLimits } from "./tokenLimits.js";

type Scope = { providerId: string; protocol: ModelProtocol; baseUrl: string };
type Cache = Record<string, Record<string, TokenLimits>>;
type Env = Record<string, string | undefined>;

/** Discovery URLs can be siblings of the inference URL, e.g. /models and /v1. */
export function metadataEndpointScope(value: string): string {
  const url = new URL(value);
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "").replace(/\/v1(?:beta)?$/, "");
  return url.toString().replace(/\/+$/, "");
}

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.providerId, scope.protocol, metadataEndpointScope(scope.baseUrl)]);
}

function cachePath(env?: Env): string {
  return join(resolvePilotHome(env), "cache", "provider-model-limits.json");
}

function readCache(env?: Env): Cache {
  try {
    const file = cachePath(env);
    if (statSync(file).size > 10 * 1024 * 1024) return {};
    const body = JSON.parse(readFileSync(file, "utf8"));
    return body?.version === 1 && body.scopes && typeof body.scopes === "object" && !Array.isArray(body.scopes) ? body.scopes : {};
  } catch { return {}; }
}

/** Read-only, synchronous fallback for config parsing, including headless/offline starts. */
export function readProviderModelLimits(scope: Scope, env?: Env): Record<string, TokenLimits> {
  try {
    const models = readCache(env)[scopeKey(scope)];
    if (!models || typeof models !== "object" || Array.isArray(models)) return {};
    return Object.fromEntries(Object.entries(models).map(([id, value]) => [id, normalizeProviderTokenLimits(value)]));
  } catch { return {}; }
}

/** Persist metadata separately from user configuration; never store credentials or raw responses. */
export function writeProviderModelLimits(scope: Scope, models: ProviderModelMetadata[], env?: Env): void {
  const file = cachePath(env), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const cache = readCache(env), key = scopeKey(scope);
    cache[key] = { ...cache[key], ...Object.fromEntries(models.map(model => [model.id, normalizeProviderTokenLimits(model)])) };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, scopes: cache }), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed, or the directory was read-only. */ }
  }
}
