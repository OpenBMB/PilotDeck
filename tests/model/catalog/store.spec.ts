import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  getCatalogCachePath,
  readCatalogSnapshot,
  refreshCatalog,
} from "../../../src/model/catalog/store.js";
import { CATALOG_SOURCES } from "../../../src/model/catalog/sources.js";
import { modelsDevFixture, openRouterFixture } from "./fixtures.js";

const temporaryHomes: string[] = [];

async function temporaryEnv(): Promise<Record<string, string>> {
  const home = await mkdtemp(join(tmpdir(), "pilotdeck-catalog-"));
  temporaryHomes.push(home);
  return { PILOT_HOME: home };
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function sourceResponse(input: string | URL | Request, etag?: string): Response {
  const url = requestUrl(input);
  const body = url === CATALOG_SOURCES.modelsDev ? modelsDevFixture() : openRouterFixture();
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}

after(async () => {
  await Promise.all(temporaryHomes.map((home) => rm(home, { recursive: true, force: true })));
});

test("refresh caches both sources, honors the TTL, and bypasses it when forced", async () => {
  const env = await temporaryEnv();
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    return sourceResponse(input);
  };

  const first = await refreshCatalog({ env, fetchImpl });
  assert.equal(calls, 2);
  assert.ok(first.updatedAt);
  assert.ok(first.catalog.openrouter.models["vendor/fixture:batch"]);
  assert.deepEqual(first.errors, {});

  await refreshCatalog({ env, fetchImpl });
  assert.equal(calls, 2);

  await refreshCatalog({ env, force: true, fetchImpl });
  assert.equal(calls, 4);
});

test("ETag revalidation keeps cached models on 304", async () => {
  const env = await temporaryEnv();
  let calls = 0;
  const conditionalHeaders: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++;
    conditionalHeaders.push(new Headers(init?.headers).get("if-none-match"));
    return calls <= 2 ? sourceResponse(input, '"catalog-v1"') : new Response(null, {
      status: 304,
      headers: { etag: '"catalog-v1"' },
    });
  };

  const first = await refreshCatalog({ env, fetchImpl });
  const refreshed = await refreshCatalog({ env, force: true, fetchImpl });

  assert.equal(calls, 4);
  assert.deepEqual(conditionalHeaders.slice(2), ['"catalog-v1"', '"catalog-v1"']);
  assert.equal(refreshed.updatedAt, first.updatedAt);
  assert.ok(refreshed.catalog.openrouter.models["vendor/fixture:batch"]);
  assert.deepEqual(refreshed.errors, {});
});

test("failed refreshes retain the last valid catalog", async () => {
  const env = await temporaryEnv();
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    return calls <= 2 ? sourceResponse(input) : new Response("upstream unavailable", { status: 503 });
  };

  const first = await refreshCatalog({ env, fetchImpl });
  const failed = await refreshCatalog({ env, force: true, fetchImpl });

  assert.ok(failed.catalog.openai.models["fixture-openai"]);
  assert.ok(failed.catalog.openrouter.models["vendor/fixture:batch"]);
  assert.match(failed.errors.modelsDev ?? "", /503/);
  assert.match(failed.errors.openrouter ?? "", /503/);
  assert.equal(failed.updatedAt, first.updatedAt);
});

test("a forced refresh waits for an in-flight normal refresh and runs it again", async () => {
  const env = await temporaryEnv();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    if (calls <= 2) await blocked;
    return sourceResponse(input);
  };

  const normal = refreshCatalog({ env, fetchImpl });
  await waitFor(() => calls === 2);
  const forced = refreshCatalog({ env, force: true, fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);

  release();
  await Promise.all([normal, forced]);
  assert.equal(calls, 4);
});

test("damaged cache falls back to the bundled catalog and network disable performs no fetch", async () => {
  const env = await temporaryEnv();
  const path = getCatalogCachePath(env);
  await mkdir(join(env.PILOT_HOME, "cache"), { recursive: true });
  await writeFile(path, "{not-json", "utf8");

  const offline = readCatalogSnapshot(env);
  assert.equal(offline.updatedAt, null);

  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    return sourceResponse(input);
  };
  await refreshCatalog({ env: { ...env, PILOTDECK_MODEL_CATALOG_NETWORK: "0" }, force: true, fetchImpl });
  assert.equal(calls, 0);
});
