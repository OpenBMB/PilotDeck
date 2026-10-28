import { resolvePilotHome } from '../utils/pilotPaths.js';
import { SearchWorkerClient } from './search/searchWorkerClient.js';
import { ByteLru, SEARCH_KINDS, emptyResults, normalize, pageResults, validateInput } from './search/searchCommon.js';
export { listSearchProjects } from './search/searchRegistry.js';

const aliases = value => Object.entries(value || {}).filter(([, title]) => typeof title === 'string')
  .map(([id, title]) => [id, title.slice(0, 500)]).sort(([a], [b]) => a.localeCompare(b));

/** Shared jobs survive tab changes; source generations invalidate completed snapshots. */
export function createGlobalSearch({ listProjects, refreshOnQuery = Boolean(listProjects), pilotHome = resolvePilotHome(), ...options } = {}) {
  const worker = new SearchWorkerClient({ pilotHome, watch: !listProjects, ...options });
  const cache = new ByteLru(64 * 1024 * 1024, 128);
  const active = new Map();
  let closed = false;
  const state = async () => worker.call('state', listProjects ? { projects: await listProjects(), forceRefresh: refreshOnQuery } : undefined);
  const search = async (body, { signal, onUpdate, userKey = 'local' } = {}) => {
    const input = validateInput(body); signal?.throwIfAborted();
    if (closed) throw new Error('Search is closed');
    const started = performance.now();
    const current = await state(); signal?.throwIfAborted();
    const key = JSON.stringify([userKey, normalize(input.query), input.projectName || '', aliases(input.sessionTitles), aliases(input.projectNames)]);
    let job = active.get(key) || cache.get(key);
    const cacheHit = Boolean(job && !current.dirty && job.revision === current.generation);
    if (job && !active.has(key) && (!cacheHit || Date.now() - job.updated > 30_000)) { cache.delete(key); job = null; }
    if (!job) job = { ...emptyResults(), stages: {}, revisions: {}, subscribers: new Set(), revision: current.generation, updated: Date.now(), tasks: {} };
    const kinds = input.kind === 'all' ? SEARCH_KINDS : [input.kind];
    let firstResultMs;
    const snapshot = () => {
      if (firstResultMs === undefined && kinds.some(kind => job.groups[kind].length)) firstResultMs = Math.round(performance.now() - started);
      return pageResults({ ...emptyResults(), groups: job.groups, partial: job.partial,
        pending: Object.fromEntries(SEARCH_KINDS.map(kind => [kind, kinds.includes(kind) && job.stages[kind] !== 'done'])),
        revision: job.revision, timings: { firstResultMs, elapsedMs: Math.round(performance.now() - started), cacheHit } }, input);
    };
    return new Promise((resolve, reject) => {
      const cleanup = () => { job.subscribers.delete(subscriber); signal?.removeEventListener('abort', abort); };
      const abort = () => {
        cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        // Shared indexing continues. A cancelled subscriber cannot cancel another view.
      };
      const subscriber = { notify: () => {
        if (signal?.aborted) return;
        const next = snapshot(); onUpdate?.(next);
        if (kinds.every(kind => job.stages[kind] === 'done')) { cleanup(); resolve(next); }
      }, fail: error => { cleanup(); reject(error); } };
      job.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true });
      const notify = () => { for (const listener of [...job.subscribers]) listener.notify(); };
      for (const kind of kinds) {
        if (job.stages[kind]) continue;
        job.stages[kind] = 'running'; active.set(key, job);
        job.tasks[kind] = worker.call('query', { ...input, kind }, { onUpdate: event => {
          job.groups[kind] = event.items; job.revision = event.revision;
          job.partial = [...new Set([...job.partial.filter(item => item !== kind), ...event.partial])];
          notify();
        } }).then(result => {
          job.stages[kind] = 'done'; job.revisions[kind] = result.generation;
          job.revision = Math.min(...Object.values(job.revisions)); job.updated = Date.now();
          notify();
        }).catch(error => {
          delete job.stages[kind];
          for (const listener of [...job.subscribers]) listener.fail(error);
        }).finally(() => {
          delete job.tasks[kind];
          if (!Object.keys(job.tasks).length) { active.delete(key); cache.set(key, job, Buffer.byteLength(JSON.stringify({ groups: job.groups, partial: job.partial }))); }
        });
      }
      subscriber.notify();
    });
  };
  search.warm = () => worker.call('warm');
  search.invalidate = async (projectName, kind) => { cache.clear(); return worker.call('invalidate', { projectName, kind }); };
  search.metrics = async () => ({ ...(await state()), queryCacheBytes: cache.bytes, queryCacheEntries: cache.entries.size, activeQueries: active.size });
  search.close = async () => { closed = true; cache.clear(); await Promise.allSettled([...active.values()].flatMap(job => Object.values(job.tasks))); await worker.close(); };
  return search;
}
