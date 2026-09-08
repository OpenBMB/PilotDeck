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

async function requestJson(url, { fetchImpl = fetch, env = process.env } = {}) {
  const token = env.PILOTDECK_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PilotDeck-Updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Release request failed (${response.status}).`);
  return response.json();
}

export async function listReleases(options = {}) {
  const repository = normalizeRepository(options.repository);
  const releases = await requestJson(`https://api.github.com/repos/${repository}/releases?per_page=100`, options);
  if (!Array.isArray(releases)) throw new Error('Invalid release response.');
  return releases.filter((item) => {
    if (item.draft || item.prerelease) return false;
    try { releaseVersion(item.tag_name); return true; } catch { return false; }
  }).sort((a, b) => compareVersions(releaseVersion(b.tag_name), releaseVersion(a.tag_name)));
}

export async function getLatestRelease(options = {}) {
  const repository = normalizeRepository(options.repository);
  const [release] = await listReleases({ ...options, repository });
  if (!release) throw new Error('No unified PilotDeck release is available.');
  if (!release.assets?.some((asset) => asset.name === 'release.json')) throw new Error('The release has no release.json manifest.');
  const base = `https://github.com/${repository}/releases/download/${release.tag_name}`;
  const manifest = await requestJson(`${base}/release.json`, options);
  if (manifest.schemaVersion !== 1 || manifest.tag !== release.tag_name
      || manifest.repository !== repository || !COMMIT_SHA.test(manifest.sourceSha || '')
      || manifest.version !== releaseVersion(release.tag_name) || !Array.isArray(manifest.assets)) {
    throw new Error('Release manifest does not match the published release.');
  }
  const names = new Set();
  const assets = manifest.assets.map((asset) => {
    if (!/^[\w.-]+$/.test(asset.name || '') || /^\.+$/.test(asset.name) || names.has(asset.name)
        || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size <= 0
        || typeof asset.platform !== 'string' || typeof asset.arch !== 'string') throw new Error('Invalid installer manifest.');
    names.add(asset.name);
    const published = release.assets.find((item) => item.name === asset.name);
    if (!published || published.size !== asset.size) throw new Error('Installer manifest does not match the published assets.');
    return { ...asset, id: published.id, sha256: asset.sha256.toLowerCase(), downloadUrl: `${base}/${encodeURIComponent(asset.name)}` };
  });
  return {
    tagName: release.tag_name, version: manifest.version, sourceSha: manifest.sourceSha, assets,
    publishedAt: release.published_at || null, body: release.body || '',
    htmlUrl: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
  };
}
