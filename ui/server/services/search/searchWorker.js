import { parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';

// Packaged runtimes contain compiled JS and deliberately omit tsx. Match the
// supervisor's source/runtime distinction before loading the development loader.
if (existsSync(new URL('../../../../src/cli/pilotdeck.ts', import.meta.url))) {
  const { register } = await import('tsx/esm/api');
  register();
}
const { SearchIndex } = await import('./searchIndex.js');
const index = new SearchIndex(workerData);
const cancelled = new Set();
parentPort.on('message', async ({ id, method, input }) => {
  if (method === 'cancel') { cancelled.add(id); return; }
  const send = value => { if (!cancelled.has(id)) parentPort.postMessage({ id, ...value }); };
  try {
    if (method === 'close') { await index.close(); send({ result: true }); parentPort.close(); return; }
    await index.initialize(input?.projects);
    if (input?.forceRefresh || index.watchError) await index.refreshCatalog(input?.projects, true);
    else await index.refreshCatalog();
    if (method === 'warm' || method === 'state') { send({ result: index.state }); return; }
    if (method === 'invalidate') { index.invalidate(input?.projectName, input?.kind); send({ result: index.state }); return; }
    if (method === 'query') {
      const started = performance.now();
      let names = index.nameResults(input, input.kind);
      send({ event: { stage: 'names', items: names, partial: [], revision: index.state.generation } });
      // Catalog mutations can race an append or a rename. Retry affected sources;
      // do not publish old documents under a newer source signature.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cancelled.has(id)) return;
        await index.ensureContent([input.kind], input.projectName, true);
        await index.refreshCatalog();
        if (!index.store.sources(input.kind, input.projectName).some(source => source.signature !== source.indexed_signature)) break;
      }
      if (cancelled.has(id)) return;
      names = index.nameResults(input, input.kind);
      const body = await index.bodyResults(input, input.kind, names);
      send({ event: { stage: 'body', ...body, revision: index.state.generation } });
      send({ result: { ...index.state, durationMs: Math.round(performance.now() - started) } });
    }
  } catch (error) { send({ error: { message: error.message, status: error.status } }); }
  finally { cancelled.delete(id); }
});
