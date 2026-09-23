// Shared release discovery. Installation policy belongs to each platform.
export const RELEASE_REPOSITORY = 'OpenBMB/PilotDeck';
export const RELEASE_TAG = /^v\d{4}\.\d{2}\.\d{2}(?:-r[1-9]\d*)?$/;
export const COMMIT_SHA = /^[a-f0-9]{40}$/;

export function normalizeRepository(value = RELEASE_REPOSITORY) {
  const repository = String(value).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some((part) => /^\.+$/.test(part))) throw new Error('Invalid release repository.');
  return repository;
}

export function releaseVersion(tag) {
  if (!RELEASE_TAG.test(tag || '')) throw new Error('Invalid release tag.');
  const [year, month, day, releaseNumber = 1] = tag.match(/\d+/g).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || !Number.isSafeInteger(releaseNumber) || releaseNumber < 1) throw new Error('Invalid release date or revision.');
  return `${year}.${month * 100 + day}.${releaseNumber - 1}`;
}

export function compareVersions(current, latest) {
  const parts = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value || '')) throw new Error('Invalid application version.');
    const result = value.split('.').map(Number);
    if (!result.every(Number.isSafeInteger)) throw new Error('Invalid application version.');
    return result;
  };
  const left = parts(current), right = parts(latest);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

async function requestJson(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PilotDeck-Updater' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Release request failed (${response.status}).`);
  return response.json();
}

export async function getLatestRelease(options = {}) {
  const repository = normalizeRepository(options.repository);
  // This public release asset is served without the GitHub REST API's shared
  // unauthenticated IP quota. The release workflow explicitly marks it Latest.
  const manifest = await requestJson(`https://github.com/${repository}/releases/latest/download/release.json`, options);
  let expectedVersion;
  try { expectedVersion = releaseVersion(manifest?.tag); }
  catch { throw new Error('Release manifest does not match the published release.'); }
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository
      || !COMMIT_SHA.test(manifest.sourceSha || '')
      || manifest.version !== expectedVersion || !Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error('Release manifest does not match the published release.');
  }
  const base = `https://github.com/${repository}/releases/download/${manifest.tag}`;
  const names = new Set();
  const assets = manifest.assets.map((asset) => {
    if (!/^[\w.-]+$/.test(asset.name || '') || /^\.+$/.test(asset.name) || names.has(asset.name)
        || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size <= 0
        || !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512 || '')
        || typeof asset.platform !== 'string' || typeof asset.arch !== 'string') throw new Error('Invalid installer manifest.');
    names.add(asset.name);
    return { ...asset, sha256: asset.sha256.toLowerCase(), downloadUrl: `${base}/${encodeURIComponent(asset.name)}` };
  });
  return {
    tagName: manifest.tag, version: manifest.version, sourceSha: manifest.sourceSha, assets,
    publishedAt: null, body: '',
    htmlUrl: `https://github.com/${repository}/releases/tag/${manifest.tag}`,
  };
}
