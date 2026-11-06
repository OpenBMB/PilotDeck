import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCiChanges, needsNativePackaging } from './classify-ci-changes.mjs';

test('ordinary UI, gateway and documentation changes keep fast regressions', () => {
  assert.equal(needsNativePackaging(['ui/src/components/chat-v2/ComposerV2.tsx', 'src/agent/loop/AgentLoop.ts', 'docs/desktop.md']), false);
});

test('chat UI keeps full Web and browser regression without unrelated native or image builds', () => {
  assert.deepEqual(classifyCiChanges(['ui/src/components/chat/hooks/useScrollFollow.ts', 'ui/e2e/chat-media-scroll.spec.mjs']),
    { packaging: false, checks: false, checkpoints: false, web: true, browser: true, docker: false });
});

test('maintained documentation and OBS-only changes do not select application builds', () => {
  for (const files of [['docs/testing.md', 'README_CN.md', 'ui/README.md'], ['.github/scripts/release_to_obs.py', '.github/workflows/obs-release-retention.yml', '.github/workflows/release-to-obs.yml']]) {
    // The OBS workflow owns its credential-free tests; it does not need Web or native builds.
    assert.deepEqual(classifyCiChanges(files), { packaging: false, checks: false, checkpoints: false, web: false, browser: false, docker: false });
  }
});

test('backend and Windows path boundaries retain cross-platform regression', () => {
  for (const file of ['src/session/store.ts', 'tests/session/workspace-checkpoints.spec.ts', 'ui/server/projects.js',
    'ui/src/components/chat-review/GitReviewTab.tsx', 'ui/src/utils/workspaceFileMention.ts',
    'ui/src/components/settings/view/computerUse/index.tsx']) {
    const selected = classifyCiChanges([file]);
    assert.equal(selected.checkpoints, true, file);
    assert.equal(selected.web, true, file);
  }
  assert.equal(classifyCiChanges(['ui/server/projects.js']).browser, false);
});

test('image inputs keep Docker verification, including shared desktop appearance sources', () => {
  for (const file of ['Dockerfile', '.dockerignore', 'docker-entrypoint.sh', 'ui/server/runtimeBootstrap.js',
    'ui/scripts/startup.js', 'scripts/prepare-computer-use.mjs', 'packages/config/index.cjs',
    'apps/desktop/src/appearance.ts', 'apps/desktop/src/interfacePreferences.ts']) {
    assert.equal(classifyCiChanges([file]).docker, true, file);
  }
  assert.equal(classifyCiChanges(['apps/desktop/src/appearance.ts']).web, true);
});

test('dependencies and routing changes exercise every selected boundary', () => {
  for (const file of ['package.json', 'ui/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.json',
    'packages/config/index.cjs', 'apps/desktop/scripts/classify-ci-changes.mjs', 'apps/desktop/scripts/classify-ci-changes.test.mjs']) {
    assert.ok(Object.values(classifyCiChanges([file])).every(Boolean), file);
  }
});

test('runtime Markdown and native updater changes retain packaging gates', () => {
  for (const file of ['skills/example/SKILL.md', 'skills/example/README.md', 'resources/runtime/prompt.md',
    'apps/desktop/src/updates.ts', 'ui/shared/releaseArtifacts.js', '.github/workflows/release.yml', '.github/workflows/desktop-windows.yml']) {
    assert.equal(classifyCiChanges([file]).packaging, true, file);
    assert.equal(classifyCiChanges([file]).checks, true, file);
  }
});

test('CLI uses the PR merge-base and retains the removed side of a rename', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-ci-scope-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(directory, 'hooks')}`, ...args], { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'CI Fixture'); git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(path.join(directory, 'src'));
    writeFileSync(path.join(directory, 'src/source space.ts'), 'fixture');
    git('add', '.'); git('commit', '-m', 'base');
    const fork = git('rev-parse', 'HEAD');
    writeFileSync(path.join(directory, 'package.json'), '{}');
    git('add', '.'); git('commit', '-m', 'unrelated main dependency change');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'fixture', fork);
    mkdirSync(path.join(directory, 'docs'));
    renameSync(path.join(directory, 'src/source space.ts'), path.join(directory, 'docs/source.md'));
    git('add', '-A'); git('commit', '-m', 'move source to documentation');
    const output = path.join(directory, 'github-output');
    const result = execFileSync(process.execPath, [fileURLToPath(new URL('./classify-ci-changes.mjs', import.meta.url)), base, git('rev-parse', 'HEAD')],
      { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    const selected = JSON.parse(result);
    assert.deepEqual(selected, { packaging: false, checks: false, checkpoints: true, web: true, browser: false, docker: true });
    for (const [key, value] of Object.entries(selected)) assert.ok(readFileSync(output, 'utf8').includes(`${key}=${value}\n`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('native dependencies, packaging, runtime bootstrap and release workflows require packages', () => {
  for (const file of ['apps/desktop/src/main.ts', 'apps/desktop/resources/installer.nsh', 'packages/config/index.cjs',
    'pnpm-lock.yaml', 'package.json', 'ui/package.json', 'tsconfig.json', 'ui/vite.config.ts',
    'scripts/prepare-computer-use.mjs', 'ui/server/services/runtimeCoordination.js', 'ui/server/webRuntimeSupervisor.js',
    'scripts/computer-use/cua-driver.json', 'scripts/lib/mac-computer-use.mjs', 'resources/cua-driver/manifest.json', 'skills/pptx/runtime/package.json',
    '.github/workflows/desktop-linux.yml', '.github/workflows/release.yml']) {
    assert.equal(needsNativePackaging([file]), true, file);
  }
});
