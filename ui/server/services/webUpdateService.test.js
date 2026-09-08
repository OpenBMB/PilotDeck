// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebUpdateService } from './webUpdateService.js';

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
const commit = (root, text) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false', 'commit', '-qm', text); return git(root, 'rev-parse', 'HEAD'); };
function artifacts(root, sha, content = 'old', clean = true) {
  for (const dir of ['dist', 'ui/dist']) {
    write(root, `${dir}/web-build.json`, JSON.stringify({ sourceSha: sha, clean, tagName: null, buildTime: '2026-09-07T00:00:00Z' }));
    write(root, `${dir}/index.js`, content);
  }
  for (const dir of ['node_modules', 'ui/node_modules']) write(root, `${dir}/marker`, content);
}
function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-web-update-'));
  temporary.push(temp);
  const upstream = path.join(temp, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  write(upstream, '.gitignore', 'node_modules/\ndist/\n');
  write(upstream, 'app.txt', 'old');
  const oldSha = commit(upstream, 'old');
  git(upstream, 'switch', '-qc', 'release');
  write(upstream, 'app.txt', 'new');
  const newSha = commit(upstream, 'new');
  const target = { tagName: 'v2026.09.07', sourceSha: newSha, publishedAt: '2026-09-07T00:00:00Z' };
  git(upstream, '-c', 'tag.gpgSign=false', 'tag', target.tagName);
  // main advances beyond the release: the updater must still install the tag.
  git(upstream, 'switch', 'main');
  const root = path.join(temp, 'deployment');
  git(temp, 'clone', '-q', '--branch', 'main', upstream, root);
  artifacts(root, oldSha);
  const build = vi.fn(async (source) => {
    artifacts(source, git(source, 'rev-parse', 'HEAD'), 'new');
    write(source, 'node_modules/.bin/tool', `NODE_PATH=${source}/node_modules/pkg`);
  });
  const latestRelease = vi.fn(async () => target);
  const create = (options = {}) => createWebUpdateService({ projectRoot: root, env: {}, repositoryUrl: upstream, isContainer: () => false, build, latestRelease, log: vi.fn(), ...options });
  return { root, upstream, oldSha, newSha, target, create, build, latestRelease };
}

describe('web deployment eligibility', () => {
  it('allows a clean main checkout behind the release', async () => {
    const f = fixture();
    expect(await f.create().check()).toMatchObject({ canUpdate: true, hasUpdate: true, latest: f.target });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.oldSha);
  });
  it.each([
    ['development', (f) => git(f.root, 'switch', '-qc', 'feature')],
    ['development', (f) => git(f.root, 'checkout', '--detach')],
    ['localChanges', (f) => write(f.root, 'app.txt', 'edited')],
    ['localChanges', (f) => write(f.root, 'untracked.txt', 'edited')],
    ['unofficial', (f) => git(f.root, 'remote', 'remove', 'origin')],
    ['unknownVersion', (f) => rmSync(path.join(f.root, 'dist/web-build.json'))],
    ['localChanges', (f) => artifacts(f.root, f.oldSha, 'old', false)],
  ])('disables %s deployments before querying releases', async (reason, change) => {
    const f = fixture(); change(f);
    const service = f.create();
    expect(await service.check()).toMatchObject({ canUpdate: false, reason });
    await expect(service.apply(f.target)).rejects.toMatchObject({ reason });
    expect(f.latestRelease).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
  });
  it('disables container and development runtimes', async () => {
    const f = fixture();
    expect(await f.create({ isContainer: () => true }).check()).toMatchObject({ canUpdate: false, reason: 'container' });
    expect(await f.create({ env: { PILOTDECK_RESTART_MODE: 'dev' } }).check()).toMatchObject({ reason: 'development' });
  });
  it('disables archives, linked worktrees and shallow clones', async () => {
    const f = fixture();
    const worktree = path.join(path.dirname(f.root), 'worktree');
    git(f.root, 'worktree', 'add', '--detach', worktree);
    expect(await f.create({ projectRoot: worktree }).check()).toMatchObject({ reason: 'development' });
    write(f.root, '.git/shallow', f.oldSha + '\n');
    expect(await f.create().check()).toMatchObject({ reason: 'shallow' });
    rmSync(path.join(f.root, '.git'), { recursive: true });
    expect(await f.create().check()).toMatchObject({ reason: 'notGit' });
  });
  it('distinguishes equal, ahead and diverged histories', async () => {
    const f = fixture();
    git(f.root, 'merge', '--ff-only', f.newSha);
    artifacts(f.root, f.newSha);
    expect(await f.create().check()).toMatchObject({ canUpdate: false, reason: 'upToDate' });
    write(f.root, 'app.txt', 'ahead');
    artifacts(f.root, commit(f.root, 'ahead'));
    expect(await f.create().check()).toMatchObject({ canUpdate: false, reason: 'ahead' });
    const g = fixture();
    write(g.root, 'app.txt', 'custom');
    artifacts(g.root, commit(g.root, 'custom'));
    expect(await g.create().check()).toMatchObject({ canUpdate: false, reason: 'diverged' });
  });
  it('does not confuse a new checkout or build with the running version', async () => {
    const f = fixture(); const service = f.create();
    git(f.root, 'merge', '--ff-only', f.newSha);
    artifacts(f.root, f.newSha);
    expect(await service.check()).toMatchObject({ reason: 'runtimeMismatch', current: { sourceSha: f.oldSha } });
  });
  it('rejects manifest/tag disagreement and network errors', async () => {
    const f = fixture();
    expect(await f.create({ latestRelease: async () => ({ ...f.target, sourceSha: f.oldSha }) }).check()).toMatchObject({ canUpdate: false, reason: 'releaseMismatch' });
    expect(await f.create({ latestRelease: async () => { throw new Error('offline'); } }).check()).toMatchObject({ canUpdate: false, checkUnavailable: true, reason: 'checkFailed' });
  });
});

describe('staged web updates', () => {
  it('installs the selected release, relocates shims, and requires a restart', async () => {
    const f = fixture(); const service = f.create();
    git(f.upstream, 'merge', '--ff-only', f.newSha);
    write(f.upstream, 'app.txt', 'unreleased'); commit(f.upstream, 'unreleased');
    await expect(service.apply(f.target)).resolves.toMatchObject({ success: true, needsRestart: true });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.newSha);
    expect(readFileSync(path.join(f.root, 'app.txt'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(f.root, 'node_modules/.bin/tool'), 'utf8')).toBe(`NODE_PATH=${f.root}/node_modules/pkg`);
    expect(service.status().lastUpdateResult.needsRestart).toBe(true);
    expect(await service.check()).toMatchObject({ reason: 'runtimeMismatch', current: { sourceSha: f.oldSha } });
    expect(await f.create().check()).toMatchObject({ reason: 'upToDate', current: { tagName: f.target.tagName } });
    expect(readdirSync(path.join(f.root, '.git')).filter((name) => name.startsWith('pilotdeck-update'))).toEqual([]);
  });
  it('revalidates eligibility and the selected target on apply', async () => {
    const f = fixture(); const service = f.create();
    expect((await service.check()).canUpdate).toBe(true);
    write(f.root, 'app.txt', 'user changes');
    await expect(service.apply(f.target)).rejects.toMatchObject({ reason: 'localChanges' });
    expect(f.build).not.toHaveBeenCalled();
    const g = fixture();
    await expect(g.create().apply({ ...g.target, tagName: 'v2026.09.06' })).rejects.toMatchObject({ reason: 'targetChanged' });
    expect(g.build).not.toHaveBeenCalled();
  });
  it('rejects raw API calls without a verified target', async () => {
    const f = fixture();
    await expect(f.create().apply()).rejects.toMatchObject({ reason: 'targetChanged' });
    expect(f.latestRelease).not.toHaveBeenCalled();
  });
  it('leaves source, dependencies and builds intact when preparation fails', async () => {
    const f = fixture();
    const service = f.create({ build: async () => { throw new Error('build failed'); } });
    await expect(service.apply(f.target)).rejects.toThrow('build failed');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.oldSha);
    for (const file of ['node_modules/marker', 'ui/dist/index.js', 'dist/index.js']) expect(readFileSync(path.join(f.root, file), 'utf8')).toBe('old');
    expect(service.status()).toMatchObject({ updateInProgress: false, lastUpdateResult: { success: false } });
  });
  it.each(['buildTimedOut', 'processStopFailed'])('settles %s with correlated status and safe cleanup', async (reason) => {
    const f = fixture();
    const service = f.create({ build: async () => { throw Object.assign(new Error(reason), { reason }); } });
    await expect(service.apply(f.target, () => {}, 'test-update')).rejects.toMatchObject({ reason });
    expect(service.status()).toMatchObject({ updateInProgress: false, currentUpdateId: null,
      lastUpdateResult: { success: false, reason, target: f.target, updateId: 'test-update' } });
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.oldSha);
    const leftovers = readdirSync(path.join(f.root, '.git')).filter(name => name.startsWith('pilotdeck-update'));
    if (reason === 'processStopFailed') {
      expect(leftovers).toContain('pilotdeck-update.lock');
      expect(leftovers.length).toBe(2);
      expect(await service.check()).toMatchObject({ canUpdate: false, reason: 'lockBusy' });
    } else expect(leftovers).toEqual([]);
  });
  it('stops when the user edits the checkout during a build', async () => {
    const f = fixture();
    const service = f.create({ build: async (source) => { await f.build(source); write(f.root, 'app.txt', 'user edit'); } });
    await expect(service.apply(f.target)).rejects.toMatchObject({ reason: 'localChanges' });
    expect(readFileSync(path.join(f.root, 'app.txt'), 'utf8')).toBe('user edit');
    expect(readFileSync(path.join(f.root, 'node_modules/marker'), 'utf8')).toBe('old');
  });
  it('restores artifacts if Git cannot fast-forward after staging', async () => {
    const f = fixture();
    const service = f.create({ build: async (source) => { await f.build(source); write(f.root, '.git/index.lock', 'locked'); } });
    await expect(service.apply(f.target)).rejects.toThrow();
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.oldSha);
    expect(readFileSync(path.join(f.root, 'node_modules/marker'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(f.root, 'dist/index.js'), 'utf8')).toBe('old');
  });
  it('prevents concurrent updates across service processes', async () => {
    const f = fixture();
    let releaseBuild;
    const started = new Promise((resolve) => { releaseBuild = resolve; });
    let entered;
    const building = new Promise((resolve) => { entered = resolve; });
    const service = f.create({ build: async (source) => { entered(); await started; await f.build(source); } });
    const applying = service.apply(f.target);
    await building;
    await expect(service.apply(f.target)).rejects.toMatchObject({ reason: 'inProgress' });
    await expect(f.create().apply(f.target)).rejects.toMatchObject({ reason: 'lockBusy' });
    releaseBuild(); await applying;
    expect(existsSync(path.join(f.root, '.git/pilotdeck-update.lock'))).toBe(false);
  });
});


describe('build version metadata', () => {
  it('records both build locations and marks modified source as unsupported', () => {
    const f = fixture();
    mkdirSync(path.join(f.root, 'scripts'));
    copyFileSync(new URL('../../../scripts/write-web-build-metadata.mjs', import.meta.url), path.join(f.root, 'scripts/write-web-build-metadata.mjs'));
    const sha = commit(f.root, 'add build metadata hook');
    const script = path.join(f.root, 'scripts/write-web-build-metadata.mjs');
    execFileSync(process.execPath, [script, 'dist'], { cwd: f.root });
    execFileSync(process.execPath, [script, 'dist'], { cwd: path.join(f.root, 'ui') });
    const read = (dir) => JSON.parse(readFileSync(path.join(f.root, dir, 'web-build.json'), 'utf8'));
    expect(read('dist')).toMatchObject({ sourceSha: sha, clean: true });
    expect(read('ui/dist')).toMatchObject({ sourceSha: sha, clean: true });
    write(f.root, 'app.txt', 'uncommitted');
    execFileSync(process.execPath, [script, 'dist'], { cwd: f.root });
    expect(read('dist')).toMatchObject({ sourceSha: sha, clean: false });
  });
});
