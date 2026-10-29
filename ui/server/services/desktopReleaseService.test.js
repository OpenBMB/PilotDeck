// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopReleaseService, OBS_BASE } from './desktopReleaseService.js';

const manifest = { schemaVersion: 1, repository: 'OpenBMB/PilotDeck', tag: 'v2026.10.28', version: '2026.1028.0',
  date: '2026-10-28', sourceSha: 'a'.repeat(40), assets: [{ name: 'installer.exe', size: 42, sha256: 'a'.repeat(64),
    sha512: 'A'.repeat(86) + '==', platform: 'win32', arch: 'x64' }] };
const response = data => ({ ok: true, json: async () => data });
const make = options => createDesktopReleaseService({ settleMs: 20, probeSettleMs: 10, timeoutMs: 100, ...options });
afterEach(() => vi.useRealTimers());

describe('desktop release routing', () => {
  it('requires an accessible payload, not just a newer manifest, and recovers after mirror sync', async () => {
    let ready = false;
    const probe = vi.fn(async (url, _signal, size) => {
      expect(size).toBe(42);
      if (!ready || !url.startsWith(OBS_BASE)) throw new Error('404 or blocked');
      return 5;
    });
    const service = make({ probe });
    const release = { tagName: manifest.tag };
    expect(await service.downloadAvailable(release, manifest.assets[0])).toBe(false);
    ready = true;
    expect(await service.downloadAvailable(release, manifest.assets[0])).toBe(true);
    expect(probe.mock.calls.every(([url]) => url.includes(`/${manifest.tag}/installer.exe`))).toBe(true);
  });
  it('does not wait for a stalled mirror after the other serves the exact payload', async () => {
    let aborted = false;
    const service = make({ probe: (url, signal) => url.startsWith(OBS_BASE)
      ? new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }))
      : Promise.resolve(1) });
    expect(await service.downloadAvailable({ tagName: manifest.tag }, manifest.assets[0])).toBe(true);
    expect(aborted).toBe(true);
  });
  it('bounds stalled availability checks and responds to cancellation', async () => {
    const probe = (_url, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const service = make({ probe, timeoutMs: 20 });
    expect(await service.downloadAvailable({ tagName: manifest.tag }, manifest.assets[0])).toBe(false);
    const controller = new AbortController();
    const checking = service.downloadAvailable({ tagName: manifest.tag }, manifest.assets[0], controller.signal);
    controller.abort();
    expect(await checking).toBe(false);
  });
  it('checks OBS first and reads its immutable manifest instead of trusting website URLs', async () => {
    const fetchImpl = vi.fn(async url => response(url.endsWith('latest.json')
      ? { tag: manifest.tag, assets: [{ url: 'https://untrusted.invalid/' }] } : manifest));
    const release = await make({ fetchImpl }).latestRelease();
    expect(release.version).toBe(manifest.version);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${OBS_BASE}latest.json`);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain(`${OBS_BASE}${manifest.tag}/release.json`);
    expect(JSON.stringify(release)).not.toContain('untrusted');
  });
  it('uses the newest valid release when the preferred mirror is behind', async () => {
    const newer = { ...manifest, tag: 'v2026.10.29', version: '2026.1029.0', date: '2026-10-29' };
    const latest = await make({ fetchImpl: async url => response(url.startsWith(OBS_BASE)
      ? (url.endsWith('latest.json') ? { tag: manifest.tag } : manifest) : newer) }).latestRelease();
    expect(latest.version).toBe(newer.version);
  });
  it('does not wait for a blocked preferred source after another source succeeds', async () => {
    let aborted = false;
    const latest = await make({ fetchImpl: (url, { signal }) => url.startsWith(OBS_BASE)
      ? new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }))
      : Promise.resolve(response(manifest)) }).latestRelease();
    expect(latest.version).toBe(manifest.version);
    expect(aborted).toBe(true);
  });
  it('rejects malformed or inconsistent metadata and continues to GitHub', async () => {
    const latest = await make({ fetchImpl: async url => response(url.startsWith(OBS_BASE) ? { tag: '../escape' } : manifest) }).latestRelease();
    expect(latest.version).toBe(manifest.version);
  });
  it('tries all routes twice before failing, without exposing source errors', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('secret source hostname'); });
    await expect(make({ fetchImpl }).latestRelease()).rejects.toThrow('checkFailed');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('recovers from temporary failures in the second round', async () => {
    let requests = 0;
    const latest = await make({ fetchImpl: async url => {
      if (++requests <= 2) throw new Error('offline');
      return response(url.endsWith('latest.json') ? { tag: manifest.tag } : manifest);
    } }).latestRelease();
    expect(latest.version).toBe(manifest.version);
  });
  it('bounds both rounds when every route stalls', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(make({ fetchImpl, timeoutMs: 20 }).latestRelease()).rejects.toThrow('checkFailed');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('never queries the official OBS bucket for a fork', async () => {
    const fetchImpl = vi.fn(async () => response({ ...manifest, repository: 'fork/PilotDeck' }));
    await make({ repository: 'fork/PilotDeck', fetchImpl }).latestRelease();
    expect(fetchImpl.mock.calls.every(([url]) => !url.startsWith(OBS_BASE) && url.includes('/fork/PilotDeck/'))).toBe(true);
  });
  it('orders only the two official downloads by measured speed and retains failed probes', async () => {
    const release = { tagName: manifest.tag }, asset = manifest.assets[0];
    const probe = vi.fn(async url => url.startsWith(OBS_BASE) ? 2500 : 100);
    const bases = await make({ probe }).downloadBases(release, asset);
    expect(bases[0]).toBe(`https://github.com/OpenBMB/PilotDeck/releases/download/${manifest.tag}/`);
    expect(bases).toHaveLength(2);
    expect(probe.mock.calls.every(([url]) => url.endsWith(`/${asset.name}`))).toBe(true);
    const similar = await make({ probe: async () => 100 }).downloadBases(release, asset);
    expect(similar[0]).toBe(`${OBS_BASE}${manifest.tag}/`);
    const failed = await make({ probe: async () => { throw new Error('no Range'); } }).downloadBases(release, asset);
    expect(failed).toEqual(similar);
  });
  it('stops before download after probe cancellation', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(make({ probe: async () => 10 }).downloadBases({ tagName: manifest.tag }, manifest.assets[0], abort.signal)).rejects.toThrow();
  });
  it('starts both official checks immediately even with a remembered route', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const service = make({ fetchImpl, timeoutMs: 20, routeStore: { read: () => ({
      schemaVersion: 1, repository: manifest.repository, source: 'github', succeededAt: Date.now(),
    }) } });
    const checking = service.latestRelease();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://github.com/OpenBMB/PilotDeck/releases/latest/download/release.json', `${OBS_BASE}latest.json`,
    ]);
    await expect(checking).rejects.toThrow('checkFailed');
  });
  it('waits beyond the collection window before declaring a stale mirror up to date', async () => {
    const newer = { ...manifest, tag: 'v2026.10.29', version: '2026.1029.0', date: '2026-10-29' };
    const latest = await make({ currentVersion: manifest.version, fetchImpl: async url => {
      if (url.startsWith(OBS_BASE)) return response(url.endsWith('latest.json') ? { tag: manifest.tag } : manifest);
      await new Promise(resolve => setTimeout(resolve, 40));
      return response(newer);
    } }).latestRelease();
    expect(latest.version).toBe(newer.version);
  });
  it.each(['obs', 'github'])('does not wait for a stalled competitor when %s finishes sampling', async winner => {
    let aborted = false;
    const probe = (url, signal) => (url.startsWith(OBS_BASE) === (winner === 'obs')) ? Promise.resolve(50)
      : new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }));
    const bases = await make({ probe }).downloadBases({ tagName: manifest.tag }, manifest.assets[0]);
    expect(bases[0].startsWith(OBS_BASE)).toBe(winner === 'obs');
    expect(aborted).toBe(true);
    expect(bases).toHaveLength(2);
  });
  it('aborts both in-flight samples when cancelled without recording a route', async () => {
    const aborted = vi.fn(), write = vi.fn();
    const probe = vi.fn((_url, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
    }));
    const service = make({ probe, routeStore: { write } });
    const controller = new AbortController();
    const sampling = service.downloadBases({ tagName: manifest.tag }, manifest.assets[0], controller.signal);
    expect(probe).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(sampling).rejects.toThrow();
    expect(aborted).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('verified route history', () => {
  const release = { tagName: manifest.tag };
  const obs = `${OBS_BASE}${manifest.tag}/`;
  const github = `https://github.com/OpenBMB/PilotDeck/releases/download/${manifest.tag}/`;
  const timestamp = 1793232000000;
  const record = { schemaVersion: 1, repository: manifest.repository, source: 'github', succeededAt: timestamp };
  function cache(initial) {
    let stored = initial;
    return { read: vi.fn(() => stored), write: vi.fn(value => { stored = value; }) };
  }
  it('persists only a successful official route and restores it in a new service', async () => {
    const routeStore = cache(null);
    const service = make({ routeStore, now: () => timestamp, probe: async () => 100 });
    await service.downloadBases(release, manifest.assets[0]);
    expect(routeStore.write).not.toHaveBeenCalled();
    service.downloadSucceeded('https://untrusted.invalid/', release);
    expect(routeStore.write).not.toHaveBeenCalled();
    service.downloadSucceeded(github, release);
    expect(routeStore.write).toHaveBeenCalledWith(record);
    const restored = make({ routeStore, now: () => timestamp + 1, probe: async () => 100 });
    expect(await restored.downloadBases(release, manifest.assets[0])).toEqual([github, obs]);
  });
  it('lets a clearly faster route override remembered history after a network change', async () => {
    const service = make({ routeStore: cache(record), now: () => timestamp, probe: async url => url.startsWith(OBS_BASE) ? 50 : 1000 });
    expect(await service.downloadBases(release, manifest.assets[0])).toEqual([obs, github]);
  });
  it('forgets a failed remembered route and records a subsequent verified fallback', async () => {
    const routeStore = cache(record);
    const service = make({ routeStore, now: () => timestamp, probe: async () => 100 });
    service.downloadFailed(github, release);
    expect(routeStore.write).toHaveBeenLastCalledWith(null);
    expect(await service.downloadBases(release, manifest.assets[0])).toEqual([obs, github]);
    service.downloadSucceeded(obs, release);
    expect(routeStore.write).toHaveBeenLastCalledWith({ ...record, source: 'obs' });
  });
  it.each([null, {}, { ...record, source: 'proxy' }, { ...record, repository: 'fork/PilotDeck' },
    { ...record, succeededAt: timestamp - 7 * 86400000 }, { ...record, succeededAt: timestamp + 1 },
    { ...record, succeededAt: 'yesterday' }])('ignores invalid, foreign or expired cache: %j', async initial => {
    const service = make({ routeStore: cache(initial), now: () => timestamp, probe: async () => 100 });
    expect(await service.downloadBases(release, manifest.assets[0])).toEqual([obs, github]);
  });
  it('tolerates unreadable and unwritable cache files', async () => {
    const service = make({ now: () => timestamp, probe: async () => 100,
      routeStore: { read: () => { throw new Error('corrupt'); }, write: () => { throw new Error('read-only disk'); } } });
    service.downloadSucceeded(github, release);
    expect(await service.downloadBases(release, manifest.assets[0])).toEqual([github, obs]);
  });
});
