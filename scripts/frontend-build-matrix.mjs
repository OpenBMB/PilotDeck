#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = resolve(root, 'ui/src/composition/generated/frontend-modules.ts');
const artifactRoot = resolve(root, 'test-results/frontend-build-matrix');
const profiles = {
  native: 'products/pilotdeck-staffdeck-sop/profiles/native.yaml',
  'native-five-staffdeck': 'products/pilotdeck-staffdeck-sop/profiles/native-five-staffdeck.yaml',
  minimal: 'products/pilotdeck-staffdeck-sop/profiles/pilotdeck-only.yaml',
  replacement: 'products/pilotdeck-staffdeck-sop/profiles/replacement-knowledge.yaml',
};
const profileFlagIndex = process.argv.indexOf('--profile');
const requestedProfile = profileFlagIndex >= 0 ? process.argv[profileFlagIndex + 1] : undefined;
if (profileFlagIndex >= 0 && !profiles[requestedProfile]) {
  throw new Error(`Unknown build-matrix profile: ${requestedProfile}`);
}
const selectedProfiles = requestedProfile ? { [requestedProfile]: profiles[requestedProfile] } : profiles;

function run(command, args, cwd = root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
    child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
    child.on('error', reject);
  });
}

const original = await readFile(generated, 'utf8');
await mkdir(artifactRoot, { recursive: true });
if (!requestedProfile) await rm(artifactRoot, { recursive: true, force: true });
try {
  for (const [name, profile] of Object.entries(selectedProfiles)) {
    const outDir = resolve(artifactRoot, name);
    const distDir = resolve(outDir, 'dist');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await run(process.execPath, ['scripts/generate-frontend-modules.mjs', '--profile', profile, '--out', generated]);
    await run('pnpm', ['exec', 'vite', 'build', '--outDir', distDir, '--logLevel', 'error'], resolve(root, 'ui'));
    const generatedText = await readFile(generated, 'utf8');
    const assets = existsSync(distDir) ? await readdir(distDir, { recursive: true }) : [];
    const selectedImports = [...generatedText.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const chunks = assets.filter((asset) => /\.(js|css)$/.test(asset));
    const javascript = await Promise.all(chunks.filter((asset) => asset.endsWith('.js')).map((asset) => readFile(resolve(distDir, asset), 'utf8')));
    const emittedSource = javascript.join('\n');
    const implementationMarkers = {
      'pilotdeck.skills': 'pilotdeck.skills.ui/v1',
      'staffdeck.sop': 'staffdeck.sop.ui/v1',
      'staffdeck.knowledge': 'staffdeck.knowledge.ui/v1',
      'fixture.knowledge-search': 'fixture.knowledge-search.ui/v1',
    };
    const selectedIds = Object.entries(implementationMarkers)
      .filter(([, marker]) => emittedSource.includes(marker))
      .map(([id]) => id);
    for (const [id, marker] of Object.entries(implementationMarkers)) {
      const expected = selectedImports.some((item) => item.includes(id.replace('.', '-')))
        || (id === 'staffdeck.sop' && selectedImports.some((item) => item.includes('staffdeck-sop')))
        || (id === 'staffdeck.knowledge' && selectedImports.some((item) => item.includes('staffdeck-knowledge')))
        || (id === 'fixture.knowledge-search' && selectedImports.some((item) => item.includes('fixture-knowledge-search')));
      if (!expected && emittedSource.includes(marker)) {
        throw new Error(`${name} emits the disabled or replaced implementation ${id}.`);
      }
    }
    await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify({ profile: name, sourceProfile: profile, selectedImports, selectedIds, chunks, result: 'passed' }, null, 2));
  }
} finally {
  await writeFile(generated, original, 'utf8');
}
process.stdout.write(`${artifactRoot}\n`);
