import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { COMMIT_SHA, getLatestRelease, RELEASE_REPOSITORY, RELEASE_TAG } from './releaseService.js';

import { runManagedCommand } from '../utils/processTree.js';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OFFICIAL_URL = `https://github.com/${RELEASE_REPOSITORY}.git`;
const ARTIFACTS = ['node_modules', 'ui/node_modules', 'dist', 'ui/dist'];

export function readWebBuildVersion(root) {
  try {
    const gateway = JSON.parse(readFileSync(path.join(root, 'dist/web-build.json'), 'utf8'));
    const ui = JSON.parse(readFileSync(path.join(root, 'ui/dist/web-build.json'), 'utf8'));
    if (!COMMIT_SHA.test(gateway.sourceSha || '') || gateway.sourceSha !== ui.sourceSha) return null;
    return { ...gateway, clean: gateway.clean === true && ui.clean === true };
  } catch { return null; }
}

function updateError(reason, message = reason) {
  return Object.assign(new Error(message), { reason, statusCode: 409 });
}

function matchesRepository(remote, repositoryUrl) {
  if (remote === repositoryUrl) return true;
  if (repositoryUrl !== OFFICIAL_URL) return false;
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)OpenBMB\/PilotDeck(?:\.git)?\/?$/i.test(remote);
}

export function createWebUpdateService({
  projectRoot = ROOT,
  env = process.env,
  current = readWebBuildVersion(projectRoot),
  latestRelease = () => getLatestRelease({ env }),
  repositoryUrl = OFFICIAL_URL,
  isContainer = () => env.DOCKER === '1' || env.container === 'docker' || existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  build = buildStagedWeb,
  log = (message) => console.log('[web-update]', message),
} = {}) {
  // Frozen at server startup: a later Git checkout/build is not a running update.
  const running = current ? { ...current } : null;
  let updateInProgress = false;
  let ownsUpdateLock = false;
  let lastUpdateResult = null;
  let currentUpdateId = null;
  const git = async (args, cwd = projectRoot) => {
    const { stdout } = await exec('git', args, {
      cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  };
  const ancestor = async (from, to) => {
    try { await git(['merge-base', '--is-ancestor', from, to]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  };

  async function inspectWorkspace() {
    if (isContainer()) throw updateError('container');
    if (env.PILOTDECK_DESKTOP === '1' || env.PILOTDECK_DESKTOP_VERSION) throw updateError('desktop');
    if (env.PILOTDECK_RESTART_MODE === 'dev' || env.NODE_ENV === 'development') throw updateError('development');
    try {
      if (!statSync(path.join(projectRoot, '.git')).isDirectory()) throw updateError('development');
      if (realpathSync(await git(['rev-parse', '--show-toplevel'])) !== realpathSync(projectRoot)) throw updateError('notGit');
    } catch (error) { throw error.reason ? error : updateError('notGit'); }
    if (!ownsUpdateLock && existsSync(path.join(projectRoot, '.git', 'pilotdeck-update.lock'))) throw updateError('lockBusy');
    const branch = await git(['branch', '--show-current']);
    if (branch !== 'main') throw updateError('development');
    if (await git(['status', '--porcelain', '--untracked-files=all'])) throw updateError('localChanges');
    for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply']) {
      if (existsSync(path.join(projectRoot, '.git', state))) throw updateError('development');
    }
    if (await git(['rev-parse', '--is-shallow-repository']) === 'true') throw updateError('shallow');
    const remotes = (await git(['remote'])).split('\n').filter(Boolean);
    let official = false;
    for (const remote of remotes) {
      if (matchesRepository(await git(['remote', 'get-url', remote]), repositoryUrl)) official = true;
    }
    if (!official) throw updateError('unofficial');
    if (!running) throw updateError('unknownVersion');
    if (!running.clean) throw updateError('localChanges');
    const head = await git(['rev-parse', 'HEAD']);
    if (head !== running.sourceSha) throw updateError('runtimeMismatch');
    // Rebuilding files in place without restarting is also not a known runtime.
    const built = readWebBuildVersion(projectRoot);
    if (!built || built.sourceSha !== running.sourceSha || !built.clean) throw updateError('runtimeMismatch');
    return head;
  }

  async function check() {
    const result = {
      source: 'github-releases', mode: 'web', hasUpdate: false, canUpdate: false,
      checkUnavailable: false, reason: null, current: running, latest: null,
      localHead: running?.sourceSha?.slice(0, 8) || 'unknown', remoteHead: '',
    };
    try {
      const head = await inspectWorkspace();
      const latest = await latestRelease();
      if (!RELEASE_TAG.test(latest?.tagName || '') || !COMMIT_SHA.test(latest?.sourceSha || '')) throw updateError('releaseUnavailable');
      result.latest = latest;
      result.remoteHead = latest.sourceSha.slice(0, 8);
      const ref = `refs/pilotdeck/releases/${latest.tagName}`;
      await git(['fetch', '--no-tags', repositoryUrl, `refs/tags/${latest.tagName}:${ref}`]);
      const releaseCommit = await git(['rev-parse', `${ref}^{commit}`]);
      if (releaseCommit !== latest.sourceSha) throw updateError('releaseMismatch');
      if (head === releaseCommit) return { ...result, current: { ...running, tagName: latest.tagName }, reason: 'upToDate' };
      if (await ancestor(head, releaseCommit)) return { ...result, hasUpdate: true, canUpdate: true };
      if (await ancestor(releaseCommit, head)) return { ...result, reason: 'ahead' };
      return { ...result, reason: 'diverged' };
    } catch (error) {
      return { ...result, reason: error.reason || 'checkFailed', checkUnavailable: !error.reason || ['releaseUnavailable', 'releaseMismatch', 'unknownVersion'].includes(error.reason) };
    }
  }

  async function apply(target, progress = () => {}, updateId = randomUUID()) {
    if (updateInProgress) throw updateError('inProgress');
    if (!RELEASE_TAG.test(target?.tagName || '') || !COMMIT_SHA.test(target?.sourceSha || '')) throw updateError('targetChanged');
    if (lastUpdateResult?.needsRestart) throw updateError('restartRequired');
    if (typeof updateId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(updateId)) throw updateError('invalidUpdateId');
    updateInProgress = true;
    currentUpdateId = updateId;
    lastUpdateResult = null;
    const report = (message) => { log(message); progress(message); };
    let staging;
    let preserveBackup = false;
    let locked = false;
    const lock = path.join(projectRoot, '.git', 'pilotdeck-update.lock');
    try {
      // Validate the deployment before creating anything in its Git directory.
      await inspectWorkspace();
      try { await mkdir(lock); locked = true; ownsUpdateLock = true; }
      catch (error) { throw updateError(error.code === 'EEXIST' ? 'lockBusy' : 'applyFailed'); }
      const status = await check();
      if (!status.canUpdate) throw updateError(status.reason || 'checkFailed');
      if (status.latest.tagName !== target.tagName || status.latest.sourceSha !== target.sourceSha) throw updateError('targetChanged');
      report('Preparing the published release in a temporary directory.');
      staging = await mkdtemp(path.join(projectRoot, '.git', 'pilotdeck-update-'));
      const source = path.join(staging, 'source');
      await git(['clone', '--shared', '--no-checkout', projectRoot, source]);
      await git(['checkout', '--detach', target.sourceSha], source);
      await build(source, report, env);
      const prepared = readWebBuildVersion(source);
      if (!prepared || !prepared.clean || prepared.sourceSha !== target.sourceSha) throw updateError('buildFailed', 'Prepared build does not match the release.');
      if (await git(['status', '--porcelain', '--untracked-files=all'], source)) throw updateError('buildFailed', 'Build modified the release source.');
      for (const artifact of ARTIFACTS) {
        if (!existsSync(path.join(source, artifact))) throw updateError('buildFailed', `Missing build output: ${artifact}`);
      }
      for (const directory of ['dist', 'ui/dist']) {
        const metadataPath = path.join(source, directory, 'web-build.json');
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        await writeFile(metadataPath, JSON.stringify({ ...metadata, tagName: target.tagName }) + '\n');
      }
      relocateDependencies(source, projectRoot);
      // Recheck after the potentially long build, before touching the live tree.
      await inspectWorkspace();
      report('Build succeeded. Applying the prepared release.');
      const moved = [];
      try {
        for (const artifact of ARTIFACTS) {
          const destination = path.join(projectRoot, artifact);
          const backup = path.join(staging, 'backup', artifact);
          await mkdir(path.dirname(backup), { recursive: true });
          const existed = existsSync(destination);
          if (existed) await rename(destination, backup);
          const item = { destination, backup, existed, installed: false };
          moved.push(item);
          await rename(path.join(source, artifact), destination);
          item.installed = true;
        }
        // No stash/reset: Git itself must still accept a fast-forward.
        if (await git(['branch', '--show-current']) !== 'main'
            || await git(['rev-parse', 'HEAD']) !== running.sourceSha
            || await git(['status', '--porcelain', '--untracked-files=all'])) throw updateError('workspaceChanged');
        await git(['-c', `core.hooksPath=${path.join(staging, 'disabled-hooks')}`, 'merge', '--ff-only', '--no-edit', target.sourceSha]);
      } catch (error) {
        try {
          for (const item of moved.reverse()) {
            if (item.installed) await rm(item.destination, { recursive: true, force: true });
            if (item.existed) await rename(item.backup, item.destination);
          }
        } catch (restoreError) {
          preserveBackup = true;
          throw updateError('manualRecovery', `Restore failed. Backups retained at ${staging}: ${restoreError.message}`);
        }
        throw error;
      }
      lastUpdateResult = { success: true, needsRestart: true, target, updateId };
      return lastUpdateResult;
    } catch (error) {
      if (error.reason === 'processStopFailed') {
        preserveBackup = true;
        log(`Build termination unconfirmed. Retained staging: ${staging}; lock: ${lock}`);
      }
      if (staging) log(error.message);
      lastUpdateResult = { success: false, error: error.message, reason: error.reason || 'applyFailed', target, updateId };
      throw error;
    } finally {
      if (staging && !preserveBackup) await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (locked && !preserveBackup) await rm(lock, { recursive: true, force: true }).catch(() => {});
      ownsUpdateLock = false;
      updateInProgress = false;
      currentUpdateId = null;
    }
  }

  return { check, apply, status: () => ({ updateInProgress, currentUpdateId, lastUpdateResult }) };
}

async function buildStagedWeb(root, progress, env) {
  const buildEnv = { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`, HUSKY: '0' };
  const run = (command, args) => runManagedCommand(command, args, { cwd: root, env: buildEnv, progress });
  await run('pnpm', ['install', '--frozen-lockfile', '--filter', 'pilotdeck', '--filter', 'pilotdeck-ui']);
  await run('pnpm', ['run', 'build:web']);
}

// pnpm uses relative package links, but generated command shims and workspace
// metadata also embed absolute paths. Rewrite only those generated text files.
function relocateDependencies(source, destination) {
  const replacePaths = (value) => value
    .split(JSON.stringify(source).slice(1, -1)).join(JSON.stringify(destination).slice(1, -1))
    .split(source.replaceAll('\\', '/')).join(destination.replaceAll('\\', '/'))
    .split(source).join(destination);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(file);
        const resolved = path.resolve(directory, target);
        const relative = path.relative(source, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw updateError('relocationFailed');
        if (path.isAbsolute(target)) {
          unlinkSync(file);
          symlinkSync(path.join(destination, relative), file, process.platform === 'win32' ? 'junction' : undefined);
        }
      } else if (entry.isDirectory()) visit(file);
      else if (path.basename(directory) === '.bin' || ['.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(entry.name)) {
        const original = readFileSync(file, 'utf8');
        const rewritten = replacePaths(original);
        if (rewritten !== original) writeFileSync(file, rewritten);
      }
    }
  };
  for (const directory of ['node_modules', 'ui/node_modules']) visit(path.join(source, directory));
}
