import { RELEASE_REPOSITORY, RELEASE_TAG, normalizeRepository, compareVersions, validateReleaseManifest } from './releaseService.js';

// Keep mirrors in code, never accept a download host from remote metadata.
export const OBS_BASE = 'https://n00069-minicpm-5-0.obs.cn-north-4.myhuaweicloud.com/PilotDeck/';
const ROUTE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function createDesktopReleaseService({ repository: value, currentVersion, fetchImpl = fetch, probe,
  routeStore, now = Date.now, settleMs = 1200, probeSettleMs = 150, timeoutMs = 8000 } = {}) {
  const repository = normalizeRepository(value);
  const github = `https://github.com/${repository}/releases/`;
  const sources = [
    ...(repository === RELEASE_REPOSITORY ? [{ id: 'obs', latest: `${OBS_BASE}latest.json`, base: tag => `${OBS_BASE}${tag}/` }] : []),
    { id: 'github', latest: `${github}latest/download/release.json`, base: tag => `${github}download/${tag}/` },
  ];
  let remembered;
  try { remembered = routeStore?.read(); } catch { /* A cache must never block updating. */ }
  function preferred() {
    return remembered?.schemaVersion === 1 && remembered.repository === repository
      && Number.isFinite(remembered.succeededAt) && now() >= remembered.succeededAt
      && now() - remembered.succeededAt < ROUTE_MAX_AGE
      && sources.some(source => source.id === remembered.source) ? remembered.source : null;
  }
  function orderedSources() {
    const id = preferred();
    return [...sources].sort((a, b) => Number(b.id === id) - Number(a.id === id));
  }
  function save(record) {
    remembered = record;
    try { routeStore?.write(record); } catch { /* Retain in-memory preference if disk is unavailable. */ }
  }
  async function json(url, signal) {
    const response = await fetchImpl(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'PilotDeck-Updater', 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error('Release request failed');
    return response.json();
  }
  async function discover(source, signal) {
    let manifest = await json(source.latest, signal);
    if (source.id === 'obs') {
      // The website pointer has no hashes. Read the full, immutable release
      // manifest and verify that it belongs to the pointer's tag.
      const tag = manifest?.tag;
      if (!RELEASE_TAG.test(tag || '')) throw new Error('Invalid release pointer');
      manifest = await json(`${source.base(tag)}release.json`, signal);
      if (manifest?.tag !== tag) throw new Error('Release pointer mismatch');
    }
    return validateReleaseManifest(manifest, repository);
  }
  return {
    async downloadAvailable(release, asset, signal) {
      signal?.throwIfAborted();
      if (!RELEASE_TAG.test(release.tagName || '') || !/^[\w.-]+$/.test(asset.name || '')
          || !Number.isSafeInteger(asset.size) || asset.size <= 0) return false;
      const stop = new AbortController();
      const bounded = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      try {
        await Promise.any(orderedSources().map(async source => {
          const elapsed = await probe(`${source.base(release.tagName)}${encodeURIComponent(asset.name)}`, bounded, asset.size);
          if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('invalidProbe');
        }));
        signal?.throwIfAborted();
        return true;
      } catch { return false; }
      finally { stop.abort(); }
    },
    async latestRelease() {
      // Both official routes start immediately, regardless of locale or the
      // remembered route. Compare versions in a bounded collection window.
      for (let round = 0; round < 2; round++) {
        const stop = new AbortController();
        const found = [];
        let settle;
        const tasks = orderedSources().map(async (source) => {
          try {
            const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
            const release = await discover(source, signal);
            found.push(release);
            // A fast but stale mirror must not prematurely report "up to date".
            if (!currentVersion || compareVersions(currentVersion, release.version) < 0) {
              settle ??= setTimeout(() => stop.abort(), settleMs);
            }
          } catch { /* Other routes and the second round remain available. */ }
        });
        await Promise.all(tasks);
        clearTimeout(settle);
        stop.abort();
        if (found.length) return found.sort((a, b) => compareVersions(b.version, a.version))[0];
      }
      throw new Error('checkFailed');
    },
    async downloadBases(release, asset, signal) {
      signal?.throwIfAborted();
      if (!RELEASE_TAG.test(release.tagName || '')) throw new Error('invalidUpdateMetadata');
      // Probe actual package bytes through the same Electron session/proxy as
      // the download. A failed probe remains a fallback (some hosts reject Range).
      const stop = new AbortController();
      const probeSignal = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
      const recent = preferred();
      let settle;
      try {
        const ranked = await Promise.all(orderedSources().map(async source => {
          const url = source.base(release.tagName);
          try {
            const elapsed = await probe(`${url}${encodeURIComponent(asset.name)}`, probeSignal, asset.size);
            if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('invalidProbe');
            // A short grace period compares close competitors without waiting
            // five seconds for an unusable route. Preserve a recent success
            // within 100 ms; a clearly faster route still wins after a move/VPN.
            settle ??= setTimeout(() => stop.abort(), probeSettleMs);
            return { url, score: elapsed - (source.id === recent ? 100 : 0) };
          } catch { return { url, score: Infinity }; }
        }));
        signal?.throwIfAborted();
        return ranked.sort((a, b) => a.score - b.score).map(item => item.url);
      } finally { clearTimeout(settle); stop.abort(); }
    },
    downloadSucceeded(base, release) {
      const source = sources.find(candidate => candidate.base(release.tagName) === base);
      if (source) save({ schemaVersion: 1, repository, source: source.id, succeededAt: now() });
    },
    downloadFailed(base, release) {
      const source = sources.find(candidate => candidate.base(release.tagName) === base);
      if (source?.id === preferred()) save(null);
    },
  };
}
