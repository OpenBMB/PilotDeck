import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';

for (const configured of [false, true]) test(`local setup selects an existing PD user from ${configured ? 'configured database before env' : 'default auth database'}`, { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-km-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'knowledge');
  const python = join(data, 'venv/bin/python');
  await mkdir(dirname(python), { recursive: true });
  // Stand in for an already installed Python service; no pip or KM package is needed.
  await writeFile(python, `#!${process.execPath}
import { createServer } from 'node:http';
if (process.argv[2] === '-c') process.exit(0);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/km/config' ? { api_protocol: 'knowledge-core/v1' }
    : req.url === '/api/km/v1/spaces' && req.method === 'GET' ? [{ id: 'local' }] : { status: 'ready' }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close());
`, { mode: 0o755 });
  const Database = createRequire(new URL('../ui/package.json', import.meta.url))('better-sqlite3');
  const database = join(directory, configured ? 'configured.sqlite' : 'auth.db');
  const db = new Database(database);
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER); INSERT INTO users VALUES (7, 1)');
  } finally { db.close(); }
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const config = join(directory, 'pilotdeck.yaml');
  const env = { ...process.env, NODE_OPTIONS: '', PILOT_HOME: directory, PILOTDECK_CONFIG_PATH: config };
  delete env.DATABASE_PATH;
  if (configured) {
    await writeFile(config, stringify({ webui: { runtime: { databasePath: database } } }));
    env.DATABASE_PATH = join(directory, 'wrong.sqlite');
  }
  const child = spawn(process.execPath, [new URL('./start-local-knowledge.mjs', import.meta.url).pathname,
    '--prepare-only', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code] = await closed;
    assert.equal(code, 0, output);
    const binding = parse(await readFile(config, 'utf8')).modules.knowledge;
    assert.equal(binding.pilotDeckUserId, '7');
    assert.deepEqual(binding.agentMethods, ['query']);
    await assert.rejects(access(join(data, '.runtime-lock')));
  } finally { clearTimeout(timer); }
});
