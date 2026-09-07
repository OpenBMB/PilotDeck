import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_REPOSITORY = 'OpenBMB/PilotDeck';
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = 'PilotDeck-Updater/1.0';

let cachedStatus = null;
let downloadJob = createIdleDownloadJob();
let downloadAbortController = null;

export function compareVersions(current, latest) {
  const currentParts = parseVersionParts(current);
  const latestParts = parseVersionParts(latest);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = currentParts[index] ?? 0;
    const right = latestParts[index] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }

  return 0;
}

export function parseVersionParts(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^pilotdeck[-_ ]?/i, '')
    .replace(/^desktop[-_ ]?/i, '')
    .replace(/^v/i, '');
  const dateMatch = /^(\d{4})[.-](\d{1,2})[.-](\d{1,2})(?:-r(\d+))?$/i.exec(normalized);
  if (dateMatch) {
    const year = Number.parseInt(dateMatch[1], 10);
    const month = Number.parseInt(dateMatch[2], 10);
    const day = Number.parseInt(dateMatch[3], 10);
    const releaseNumber = dateMatch[4] ? Number.parseInt(dateMatch[4], 10) : 1;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && releaseNumber >= 1) {
      return [year, month * 100 + day, releaseNumber - 1];
    }
  }
  const matches = normalized.match(/\d+/g);
  return matches?.map((part) => Number.parseInt(part, 10)).filter(Number.isFinite) ?? [0];
}

export function normalizeRepository(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_REPOSITORY;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return `${parts[0]}/${parts[1]}`;
      }
    } catch {
      return DEFAULT_REPOSITORY;
    }
  }

  const match = raw.replace(/\.git$/, '').match(/^([^/\s]+)\/([^/\s]+)$/);
  return match ? `${match[1]}/${match[2]}` : DEFAULT_REPOSITORY;
}

export function mapGitHubRelease(release) {
  const tagName = String(release?.tag_name || '').trim();
  const version = normalizeDesktopReleaseVersion(tagName)
    || tagName.replace(/^v/i, '')
    || String(release?.name || '').trim();
  const assets = Array.isArray(release?.assets)
    ? release.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
        contentType: asset.content_type,
        createdAt: asset.created_at,
        updatedAt: asset.updated_at,
      }))
    : [];

  return {
    id: release?.id,
    tagName,
    version,
    name: release?.name || tagName,
    body: release?.body || '',
    htmlUrl: release?.html_url || '',
    publishedAt: release?.published_at || release?.created_at || null,
    prerelease: Boolean(release?.prerelease),
    draft: Boolean(release?.draft),
    assets,
  };
}

export function isDesktopRelease(release) {
  return /^desktop-v\d{4}\.\d{2}\.\d{2}(?:-r\d+)?$/i.test(String(release?.tagName || release?.tag_name || '').trim());
}

export function normalizeDesktopReleaseVersion(tagName) {
  const match = /^desktop-v(\d{4})\.(\d{2})\.(\d{2})(?:-r(\d+))?$/i.exec(String(tagName || '').trim());
  if (!match) return '';
  const [, year, month, day, releaseNumber] = match;
  const revision = releaseNumber ? Math.max(0, Number.parseInt(releaseNumber, 10) - 1) : 0;
  return `${Number(year)}.${Number(month) * 100 + Number(day)}.${revision}`;
}

export function selectDesktopAsset(release, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const scored = assets
    .map((asset) => ({
      asset,
      score: scoreAsset(asset, platform, arch),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.asset ?? null;
}

export async function getCurrentDesktopVersion(options = {}) {
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const packageVersion = readPackageVersion(projectRoot);
  const commit = await getCurrentCommit(projectRoot, env);
  const buildTime = await getBuildTime(projectRoot, env);

  return {
    version:
      firstNonEmpty(
        env.PILOTDECK_DESKTOP_VERSION,
        env.PILOTDECK_VERSION,
        env.APP_VERSION,
        env.npm_package_version,
        packageVersion,
      ) || '0.0.0',
    buildTime,
    commit,
    platform: process.platform,
    arch: process.arch,
    desktop: env.PILOTDECK_DESKTOP === '1' || Boolean(env.PILOTDECK_DESKTOP_VERSION),
  };
}

export async function getDesktopUpdateStatus(options = {}) {
  const env = options.env || process.env;
  const force = Boolean(options.force);
  const now = options.now || new Date();

  if (!force && cachedStatus && Date.now() - cachedStatus.cachedAt < CACHE_TTL_MS) {
    return { ...cachedStatus.status, cached: true };
  }

  const current = await getCurrentDesktopVersion({ env, projectRoot: options.projectRoot });
  const repository = normalizeRepository(env.PILOTDECK_UPDATE_REPOSITORY || env.PILOTDECK_RELEASE_REPOSITORY);

  try {
    const latest = await fetchLatestRelease({ env, repository, includePrerelease: shouldIncludePrerelease(env) });
    const selectedAsset = selectDesktopAsset(latest, {
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
    });
    const comparison = compareVersions(current.version, latest.version || latest.tagName);
    const hasUpdate = comparison < 0;
    const status = {
      source: 'github-releases',
      scope: 'desktop',
      repository,
      status: hasUpdate ? 'update-available' : 'up-to-date',
      hasUpdate,
      updateAvailable: hasUpdate,
      checkUnavailable: false,
      current,
      latest: {
        ...latest,
        selectedAsset,
      },
      lastCheckedAt: now.toISOString(),
    };

    cachedStatus = { cachedAt: Date.now(), status };
    return status;
  } catch (error) {
    const status = {
      source: 'github-releases',
      scope: 'desktop',
      repository,
      status: 'unavailable',
      hasUpdate: false,
      updateAvailable: false,
      checkUnavailable: true,
      current,
      latest: null,
      lastCheckedAt: now.toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    cachedStatus = { cachedAt: Date.now(), status };
    return status;
  }
}

export async function listDesktopReleases(options = {}) {
  const env = options.env || process.env;
  const repository = normalizeRepository(env.PILOTDECK_UPDATE_REPOSITORY || env.PILOTDECK_RELEASE_REPOSITORY);
  const limit = clampInteger(options.limit, 1, 30, 10);
  const releases = await fetchReleases({
    env,
    repository,
    limit,
    desktopOnly: true,
    includePrerelease: options.includePrerelease ?? shouldIncludePrerelease(env),
  });
  return {
    source: 'github-releases',
    scope: 'desktop',
    repository,
    releases,
  };
}

export function getDesktopDownloadStatus() {
  return { ...downloadJob };
}

export async function startDesktopUpdateDownload(options = {}) {
  if (downloadJob.state === 'downloading') {
    const error = new Error('Desktop update download already in progress.');
    error.statusCode = 409;
    throw error;
  }

  const status = options.status || await getDesktopUpdateStatus({ force: options.force });
  if (status.checkUnavailable || !status.latest) {
    const error = new Error(status.message || 'Unable to resolve the latest desktop release.');
    error.statusCode = 503;
    throw error;
  }

  const asset = resolveDownloadAsset(status.latest, options);
  if (!asset?.downloadUrl) {
    const error = new Error('No compatible desktop installer asset was found for this platform.');
    error.statusCode = 404;
    throw error;
  }

  const destinationDir = getUpdateCacheDir(options.env || process.env, status.latest.tagName || status.latest.version);
  mkdirSync(destinationDir, { recursive: true });
  const destinationPath = path.join(destinationDir, sanitizeFilename(asset.name || 'pilotdeck-update'));
  const partialPath = `${destinationPath}.download`;

  downloadAbortController = new AbortController();
  downloadJob = {
    id: `${Date.now()}`,
    state: 'downloading',
    progress: 0,
    receivedBytes: 0,
    totalBytes: asset.size ?? null,
    asset,
    release: {
      tagName: status.latest.tagName,
      version: status.latest.version,
      name: status.latest.name,
      htmlUrl: status.latest.htmlUrl,
    },
    filePath: destinationPath,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  runDownload(asset.downloadUrl, partialPath, destinationPath, downloadAbortController.signal)
    .then((result) => {
      downloadJob = {
        ...downloadJob,
        state: 'downloaded',
        progress: 1,
        receivedBytes: result.receivedBytes,
        totalBytes: result.totalBytes ?? downloadJob.totalBytes,
        completedAt: new Date().toISOString(),
      };
      downloadAbortController = null;
    })
    .catch((error) => {
      downloadJob = {
        ...downloadJob,
        state: error?.name === 'AbortError' ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
      downloadAbortController = null;
      rm(partialPath, { force: true }).catch(() => {});
    });

  return getDesktopDownloadStatus();
}

export function cancelDesktopUpdateDownload() {
  if (downloadJob.state !== 'downloading' || !downloadAbortController) {
    return { cancelled: false, download: getDesktopDownloadStatus() };
  }
  downloadAbortController.abort();
  return { cancelled: true, download: getDesktopDownloadStatus() };
}

export function launchDownloadedDesktopUpdate(options = {}) {
  const filePath = options.filePath || downloadJob.filePath;
  if (!filePath || !existsSync(filePath)) {
    const error = new Error('No downloaded desktop update installer is available.');
    error.statusCode = 404;
    throw error;
  }

  const cacheRoot = getUpdateCacheRoot(options.env || process.env);
  const resolvedPath = path.resolve(filePath);
  const relativeToCache = path.relative(path.resolve(cacheRoot), resolvedPath);
  if (relativeToCache.startsWith('..') || path.isAbsolute(relativeToCache)) {
    const error = new Error('Installer path is outside the PilotDeck update cache.');
    error.statusCode = 400;
    throw error;
  }

  const { command, args } = getOpenFileSpawnCommand(resolvedPath);
  const child = execFile(command, args, {
    cwd: path.dirname(resolvedPath),
    windowsHide: process.platform === 'win32',
  });
  child.on('error', () => {});

  return {
    launched: true,
    filePath: resolvedPath,
    needsRestart: true,
    message: 'Installer launched. Complete the installer flow, then restart PilotDeck.',
  };
}

export function resetDesktopUpdateStateForTesting() {
  cachedStatus = null;
  downloadJob = createIdleDownloadJob();
  downloadAbortController = null;
}

async function fetchLatestRelease(options) {
  const releases = await fetchReleases({ ...options, limit: 30, desktopOnly: true });
  const release = releases.find((item) => !item.draft);
  if (!release) throw new Error('No PilotDeck desktop releases are available.');
  return release;
}

async function fetchReleases(options) {
  // Filter after fetching so unrelated Web/server releases cannot hide a
  // desktop release simply because the caller requested a small result page.
  const perPage = options.desktopOnly ? 100 : Math.min(options.limit, 100);
  const url = `https://api.github.com/repos/${options.repository}/releases?per_page=${perPage}`;
  const releases = await fetchJson(url, options.env);
  if (!Array.isArray(releases)) {
    throw new Error('GitHub releases response was not a list.');
  }

  return releases
    .map(mapGitHubRelease)
    .filter((release) => !release.draft)
    .filter((release) => !options.desktopOnly || isDesktopRelease(release))
    .filter((release) => options.includePrerelease || !release.prerelease)
    .slice(0, options.limit);
}

async function fetchJson(url, env) {
  const timeoutMs = clampInteger(env.PILOTDECK_UPDATE_TIMEOUT_MS, 1_000, 120_000, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: createGitHubHeaders(env),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub release request failed (${response.status} ${response.statusText})`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function createGitHubHeaders(env) {
  const token = firstNonEmpty(env.PILOTDECK_GITHUB_TOKEN, env.GITHUB_TOKEN);
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function runDownload(url, partialPath, destinationPath, signal) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Installer download failed (${response.status} ${response.statusText})`);
  }
  if (!response.body) {
    throw new Error('Installer download response did not include a body.');
  }

  const totalBytes = Number.parseInt(response.headers.get('content-length') || '', 10);
  const writer = createWriteStream(partialPath);
  let writeError = null;
  writer.on('error', (error) => {
    writeError = error;
  });
  let receivedBytes = 0;

  try {
    for await (const chunk of response.body) {
      if (writeError) throw writeError;
      if (signal.aborted) {
        const error = new Error('Download cancelled.');
        error.name = 'AbortError';
        throw error;
      }

      receivedBytes += chunk.length;
      downloadJob = {
        ...downloadJob,
        receivedBytes,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : downloadJob.totalBytes,
        progress: Number.isFinite(totalBytes) && totalBytes > 0
          ? Math.min(receivedBytes / totalBytes, 0.999)
          : 0,
      };

      if (!writer.write(chunk)) {
        await waitForDrain(writer);
      }
    }

    if (writeError) throw writeError;
    await finishWriter(writer);
    renameSync(partialPath, destinationPath);
    return {
      receivedBytes,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    };
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

function finishWriter(writer) {
  return new Promise((resolve, reject) => {
    writer.once('error', reject);
    writer.end(() => {
      writer.off('error', reject);
      resolve();
    });
  });
}

function waitForDrain(writer) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      writer.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      writer.off('drain', onDrain);
      reject(error);
    };
    writer.once('drain', onDrain);
    writer.once('error', onError);
  });
}

function getOpenFileSpawnCommand(filePath, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${filePath.replace(/"/g, '""')}"`] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [filePath] };
  }
  return { command: 'xdg-open', args: [filePath] };
}

function resolveDownloadAsset(release, options) {
  if (options.assetId) {
    const id = Number(options.assetId);
    return release.assets.find((asset) => Number(asset.id) === id) ?? null;
  }
  if (options.assetName) {
    return release.assets.find((asset) => asset.name === options.assetName) ?? null;
  }
  return release.selectedAsset || selectDesktopAsset(release, options);
}

function scoreAsset(asset, platform, arch) {
  const name = String(asset?.name || '').toLowerCase();
  if (!name || /\.(?:blockmap|yml|yaml|sha256|sha512|sig|asc|txt)$/i.test(name)) return 0;
  if (/source[ -_]?code/.test(name)) return 0;

  const platformScore = scorePlatform(name, platform);
  if (platformScore <= 0) return 0;

  return platformScore + scoreExtension(name, platform) + scoreArch(name, arch);
}

function scorePlatform(name, platform) {
  if (platform === 'darwin') {
    if (/(mac|macos|darwin|osx|\.dmg$|\.pkg$)/.test(name)) return 100;
    return 0;
  }
  if (platform === 'win32') {
    if (/(win|windows|setup|installer|\.exe$|\.msi$)/.test(name)) return 100;
    return 0;
  }
  if (platform === 'linux') {
    if (/(linux|appimage|\.deb$|\.rpm$|\.tar\.gz$)/.test(name)) return 100;
    return 0;
  }
  return 0;
}

function scoreExtension(name, platform) {
  const priorities = {
    darwin: [['.dmg', 40], ['.pkg', 35], ['.zip', 10]],
    win32: [['.exe', 40], ['.msi', 35], ['.zip', 10]],
    linux: [['.appimage', 40], ['.deb', 35], ['.rpm', 30], ['.tar.gz', 10]],
  };
  return priorities[platform]?.find(([extension]) => name.endsWith(extension))?.[1] ?? 0;
}

function scoreArch(name, arch) {
  if (/(universal|all)/.test(name)) return 20;
  const assetArch = /(arm64|aarch64)/.test(name)
    ? 'arm64'
    : /(x64|x86_64|amd64)/.test(name)
      ? 'x64'
      : /(ia32|i386|(?:^|[-_.])x86(?:[-_.]|$))/.test(name)
        ? 'ia32'
        : null;
  if (!assetArch) return 0;
  return assetArch === arch ? 25 : -200;
}

function readPackageVersion(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return parsed.version || null;
  } catch {
    return null;
  }
}

async function getCurrentCommit(projectRoot, env) {
  const fromEnv = firstNonEmpty(env.PILOTDECK_COMMIT_SHA, env.GIT_COMMIT, env.VERCEL_GIT_COMMIT_SHA);
  if (fromEnv) return fromEnv;

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getBuildTime(projectRoot, env) {
  const fromEnv = firstNonEmpty(
    env.PILOTDECK_DESKTOP_BUILD_TIME,
    env.PILOTDECK_BUILD_TIME,
    env.BUILD_TIME,
    env.npm_package_build_time,
  );
  if (fromEnv) return fromEnv;

  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: projectRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function shouldIncludePrerelease(env) {
  return env.PILOTDECK_UPDATE_INCLUDE_PRERELEASE === '1'
    || env.PILOTDECK_UPDATE_CHANNEL === 'beta'
    || env.PILOTDECK_UPDATE_CHANNEL === 'nightly';
}

function getUpdateCacheRoot(env) {
  return env.PILOTDECK_UPDATE_CACHE_DIR
    ? path.resolve(env.PILOTDECK_UPDATE_CACHE_DIR)
    : path.join(os.homedir(), '.pilotdeck', 'updates');
}

function getUpdateCacheDir(env, releaseName) {
  return path.join(getUpdateCacheRoot(env), sanitizeFilename(releaseName || 'latest'));
}

function sanitizeFilename(value) {
  return String(value || 'download')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+$/, 'download')
    .trim() || 'download';
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function createIdleDownloadJob() {
  return {
    id: null,
    state: 'idle',
    progress: 0,
    receivedBytes: 0,
    totalBytes: null,
    asset: null,
    release: null,
    filePath: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}
