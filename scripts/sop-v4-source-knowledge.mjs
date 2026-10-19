import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { startLocalKnowledgeRuntime } from '../src/composition/localKnowledgeRuntime.mjs';
const root = process.argv[2];
await unlink(join(root, 'knowledge-ready.json')).catch(() => {});
const config = YAML.parse(await readFile(join(root, 'home/pilotdeck.yaml'), 'utf8'));
const abort = new AbortController();
let runtime;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { abort.abort(); await runtime?.stop(); process.exit(0); });
runtime = await startLocalKnowledgeRuntime(config.modules.knowledge, { signal: abort.signal, onExit: error => { console.error(error); process.exitCode = 1; } });
if (abort.signal.aborted) { await runtime.stop(); process.exit(0); }
const endpoint = config.modules.knowledge.endpoint;
const token = process.env[config.modules.knowledge.credentialEnv];
const headers = token ? { authorization: `Bearer ${token}` } : {};
try {
  const response = await fetch(`${endpoint}/api/km/v1/spaces`, { headers });
  if (!response.ok) throw Error(`KM space initialization HTTP ${response.status}`);
  const existing = await response.json();
  for (const space of config.modules.knowledge.spaces ?? []) if (!existing.some(row => row.id === space.id)) {
    const created = await fetch(`${endpoint}/api/km/v1/spaces`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(space) });
    if (!created.ok) throw Error(`KM space initialization HTTP ${created.status}`);
  }
  await writeFile(join(root, 'knowledge-ready.json'), JSON.stringify({ pid: process.pid }));
} catch (error) { await runtime.stop(); throw error; }
