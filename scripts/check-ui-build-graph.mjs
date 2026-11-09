#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const defaultDist = path.resolve(path.dirname(scriptPath), '../ui/dist');
const startupRoots = ['index.html', 'src/App.tsx'];
const featureEntries = {
  CodeEditor: 'src/components/code-editor/view/CodeEditor.tsx',
  PdfDocumentPreview: 'src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx',
};
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isJavaScript = file => /\.m?js$/i.test(file);
const isCodeMirror = value => /(?:^|[/\\])_?vendor-codemirror(?:[-.]|$)/.test(value);

/** Follow static imports only: lazy feature imports are deliberately excluded. */
function staticClosure(manifest, roots) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const key = pending.pop();
    if (visited.has(key) || !Object.hasOwn(manifest, key)) continue;
    visited.add(key);
    pending.push(...(manifest[key].imports ?? []));
  }
  return visited;
}

function filesFor(manifest, keys) {
  return [...new Set([...keys].map(key => manifest[key].file).filter(isJavaScript))].sort();
}

function analyzeManifest(manifest) {
  if (!isRecord(manifest)) throw new Error('The Vite manifest must be an object.');
  const violations = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!isRecord(chunk) || typeof chunk.file !== 'string' || !chunk.file) {
      throw new Error(`Manifest entry ${key} has no emitted file.`);
    }
    for (const edge of ['imports', 'dynamicImports']) {
      if (chunk[edge] === undefined) continue;
      if (!Array.isArray(chunk[edge]) || chunk[edge].some(value => typeof value !== 'string')) {
        throw new Error(`Manifest entry ${key} has invalid ${edge}.`);
      }
      for (const dependency of chunk[edge]) {
        if (!Object.hasOwn(manifest, dependency)) violations.push(`${key} references missing ${edge} entry ${dependency}.`);
      }
    }
  }
  const resolvedRoots = Object.fromEntries(startupRoots.map(root => [root, Object.hasOwn(manifest, root) ? root : null]));
  if (!resolvedRoots['src/App.tsx']) {
    // Vite may emit App as a shared facade without its original source key.
    // Only the bootstrap entry's unique App import can stand in for that root.
    const candidates = [...new Set(manifest['index.html']?.dynamicImports ?? [])].filter(key =>
      manifest[key]?.name === 'App' && manifest[key]?.isDynamicEntry === true && isJavaScript(manifest[key].file));
    if (candidates.length === 1) resolvedRoots['src/App.tsx'] = candidates[0];
    if (candidates.length > 1) violations.push('Required startup root src/App.tsx has ambiguous App facades.');
  }
  for (const [source, key] of Object.entries(resolvedRoots)) {
    if (!key) violations.push(`Required startup root ${source} is missing.`);
    else if (!isJavaScript(manifest[key].file)) violations.push(`Required startup root ${source} must emit JavaScript.`);
  }
  const startup = staticClosure(manifest, Object.values(resolvedRoots).filter(Boolean));
  const startupFiles = filesFor(manifest, startup);
  const features = {};
  for (const [name, entry] of Object.entries(featureEntries)) {
    const chunk = manifest[entry];
    if (!chunk) {
      violations.push(`Required dynamic entry ${entry} is missing.`);
      continue;
    }
    const staticFiles = filesFor(manifest, staticClosure(manifest, [entry]));
    features[name] = { entry, file: chunk.file, staticFiles };
    if (chunk.isDynamicEntry !== true) violations.push(`${name} must be a dynamic entry.`);
    if (!isJavaScript(chunk.file)) violations.push(`${name} must emit JavaScript.`);
    if (startupFiles.includes(chunk.file)) violations.push(`${name} is in the startup static-import closure.`);
  }
  if (features.CodeEditor && features.PdfDocumentPreview
    && features.CodeEditor.staticFiles.includes(features.PdfDocumentPreview.file)) {
    violations.push('PdfDocumentPreview is in the CodeEditor static-import closure.');
  }
  for (const key of startup) {
    const chunk = manifest[key];
    if ([key, chunk.name ?? '', chunk.file].some(isCodeMirror)) {
      violations.push(`CodeMirror chunk ${chunk.file} is in the startup static-import closure.`);
    }
  }
  return { roots: startupRoots, resolvedRoots, startupFiles, features, violations };
}

function emittedFilePath(dist, file) {
  const normalized = file.replaceAll('\\', '/');
  const target = path.resolve(dist, normalized);
  const relative = path.relative(dist, target);
  if (/^(?:[a-z]+:|\/)/i.test(normalized) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Emitted file must stay inside the build directory: ${file}`);
  }
  return target;
}

/** Report each startup JavaScript asset once, with independent gzip estimates. */
export async function inspectUiBuild(distDirectory = defaultDist) {
  const dist = path.resolve(distDirectory);
  const manifest = JSON.parse(await readFile(path.join(dist, '.vite/manifest.json'), 'utf8'));
  const { roots, resolvedRoots, startupFiles, features, violations } = analyzeManifest(manifest);
  const files = await Promise.all(startupFiles.map(async file => {
    const content = await readFile(emittedFilePath(dist, file));
    return { file, rawBytes: content.length, gzipBytes: gzipSync(content).length };
  }));
  return {
    roots,
    resolvedRoots,
    startup: {
      files,
      rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
      gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    },
    features,
    violations,
    valid: violations.length === 0,
  };
}

async function main(args) {
  let dist = defaultDist;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--dist' || !args[1] || args[1].startsWith('--')) {
      throw new Error('Usage: node scripts/check-ui-build-graph.mjs [--dist <build-directory>]');
    }
    dist = args[1];
  }
  const report = await inspectUiBuild(dist);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`UI build graph check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
