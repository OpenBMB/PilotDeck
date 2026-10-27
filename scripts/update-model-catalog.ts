import { writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PROVIDER_CATALOG } from "../src/model/catalog/providers.js";
import { CATALOG_SOURCES, mergeCatalog, validateCatalog, type CatalogSource } from "../src/model/catalog/sources.js";
import { fetchCatalogSource } from "../src/model/catalog/store.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) throw new Error("Usage: update-model-catalog [--check]");
validateCatalog(PROVIDER_CATALOG);
if (args.includes("--check")) {
  console.log(`Catalog valid: ${Object.keys(PROVIDER_CATALOG).length} providers, ${Object.values(PROVIDER_CATALOG).reduce((n, p) => n + Object.keys(p.models).length, 0)} models.`);
} else {
  const sources = Object.keys(CATALOG_SOURCES) as CatalogSource[];
  const results = await Promise.all(sources.map(source => fetchCatalogSource(source, PROVIDER_CATALOG)));
  let catalog = PROVIDER_CATALOG;
  for (const result of results) catalog = mergeCatalog(catalog, result.models!);
  validateCatalog(catalog);
  for (const [id, p] of Object.entries(catalog)) {
    const previous = PROVIDER_CATALOG[id]?.models ?? {};
    const added = Object.keys(p.models).filter(id => !previous[id]).length;
    const changed = Object.entries(p.models).filter(([id, m]) => previous[id] && JSON.stringify(previous[id]) !== JSON.stringify(m)).length;
    console.log(`${id}: ${Object.keys(p.models).length} models (${added} added, ${changed} changed)`);
  }
  const lines = ['// Generated model catalog. Update with `npm run models:update`.', 'import type { ProviderCatalog } from "./types.js";', '', `export const CATALOG_GENERATED_AT = ${Date.now()};`, 'export const BUNDLED_CATALOG: ProviderCatalog = {'];
  for (const [id, { models, ...provider }] of Object.entries(catalog)) {
    lines.push(`  ${JSON.stringify(id)}: { ...${JSON.stringify(provider)}, models: {`);
    for (const modelId of Object.keys(models).sort()) lines.push(`    ${JSON.stringify(modelId)}: ${JSON.stringify(models[modelId])},`);
    lines.push('  } },');
  }
  lines.push('};', '');
  const output = fileURLToPath(new URL('../src/model/catalog/bundled.generated.ts', import.meta.url));
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, lines.join('\n'));
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  console.log('Updated bundled catalog. Review capability and lifecycle changes before committing.');
}
