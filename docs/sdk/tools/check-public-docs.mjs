#!/usr/bin/env node
/* Check package exports, documented runtime symbols, and local Markdown links. */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const docs = path.join(root, "docs/sdk");
const sdk = path.join(root, "packages/sdk");
const pkg = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8"));
const errors = [];

for (const [entry, target] of Object.entries(pkg.exports)) {
  if (!fs.existsSync(path.join(sdk, target.types))) errors.push(`missing declaration for ${entry}: ${target.types}`);
  if (!fs.existsSync(path.join(sdk, target.import))) errors.push(`missing runtime for ${entry}: ${target.import}`);
}

const reference = fs.readFileSync(path.join(docs, "public/reference/typescript.zh.md"), "utf8");
const section = reference.match(/### Runtime functions and classes([\s\S]*?)(?:\n### |\n## |$)/)?.[1] ?? "";
const documented = new Set([...section.matchAll(/`([^`]+)`/g)]
  .flatMap(([, value]) => value.split(/[、/]/).map((symbol) => symbol.trim()))
  .filter((symbol) => symbol && !symbol.includes(" ")));
const declarations = fs.readdirSync(path.join(sdk, "dist"))
  .filter((name) => name.endsWith(".d.ts"))
  .map((name) => fs.readFileSync(path.join(sdk, "dist", name), "utf8"))
  .join("\n");
for (const symbol of documented) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${escaped}\\b`).test(declarations)) errors.push(`runtime symbol not found in dist declarations: ${symbol}`);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith(".md")) checkLinks(file);
  }
}
function checkLinks(file) {
  const content = fs.readFileSync(file, "utf8");
  for (const [, target] of content.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) errors.push(`broken local link: ${path.relative(root, file)} -> ${target}`);
  }
}
walk(docs);

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`docs contract OK: ${documented.size} runtime symbols, ${Object.keys(pkg.exports).length} package exports`);
}
