import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

let cached;

function normalizeDefault(value) {
  return value?.default ?? value;
}

export function runtimeRoot() {
  const root = process.env.PPTX_RUNTIME_ROOT;
  if (!root) throw new Error('PPTX_RUNTIME_ROOT is not set; run through scripts/pptx.sh');
  return path.resolve(root);
}

export function loadDependencies() {
  if (cached) return cached;
  const manifest = path.join(runtimeRoot(), 'package.json');
  if (!fs.existsSync(manifest)) throw new Error(`PPTX runtime manifest not found: ${manifest}`);
  const require = createRequire(manifest);
  cached = {
    JSZip: normalizeDefault(require('jszip')),
    xmldom: require('@xmldom/xmldom'),
  };
  return cached;
}
