import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SAFE_NATIVE_FRONTEND_PROFILE, resolveFrontendProfile } from './frontend-profile.mjs';
import { prepareDevFrontend, resolveDevProfile } from './dev-launcher.mjs';

test('uses the checked-in native profile when no environment selects a composition', () => {
  assert.equal(resolveFrontendProfile({ frontendProfile: '', configPath: '' }).path, SAFE_NATIVE_FRONTEND_PROFILE);
});

test('uses the runtime config profile and rejects a diverging explicit frontend profile', () => {
  const profile = 'products/pilotdeck-staffdeck-sop/profiles/replacement-knowledge.yaml';
  assert.match(resolveFrontendProfile({ frontendProfile: '', configPath: profile }).path, /replacement-knowledge\.yaml$/);
  assert.throws(() => resolveFrontendProfile({
    frontendProfile: 'products/pilotdeck-staffdeck-sop/profiles/native.yaml',
    configPath: profile,
  }), /must name the same profile/);
});

test('root dev preparation generates from the same profile it passes to the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pilotdeck-frontend-profile-'));
  const outputPath = join(directory, 'frontend-modules.ts');
  try {
    const profile = resolveDevProfile({ PILOTDECK_CONFIG_PATH: 'products/pilotdeck-staffdeck-sop/profiles/replacement-knowledge.yaml' });
    await prepareDevFrontend({ profilePath: profile.path, outputPath });
    const source = await readFile(outputPath, 'utf8');
    assert.match(source, /fixture-knowledge-search/);
    assert.doesNotMatch(source, /staffdeck-knowledge/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
