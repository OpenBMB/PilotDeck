#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { KNOWLEDGE_CORE_METHODS } from '../src/composition/knowledgeCoreOperations.mjs';
import { startLocalKnowledgeRuntime } from '../src/composition/localKnowledgeRuntime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (name === '--prepare-only') options.prepareOnly = true;
  else if (['--km-package', '--python', '--config', '--data-directory', '--port', '--user-id'].includes(name) && args[i + 1]) options[name.slice(2)] = args[++i];
  else throw Error(`Unknown or incomplete argument: ${name}`);
}
const homeValue = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
const pilotHome = resolve(homeValue.startsWith('~/') ? join(homedir(), homeValue.slice(2)) : homeValue);
const configPath = resolve(options.config || process.env.PILOTDECK_CONFIG_PATH || join(pilotHome, 'pilotdeck.yaml'));
const env = { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_CONFIG_PATH: configPath };
if (!env.PILOTDECK_GATEWAY_URL && env.PILOTDECK_GATEWAY_PORT)
  env.PILOTDECK_GATEWAY_URL = `ws://127.0.0.1:${env.PILOTDECK_GATEWAY_PORT}/ws`;
const config = existsSync(configPath) ? parse(await readFile(configPath, 'utf8')) : {};
if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('PilotDeck configuration must be an object');
const existing = config.modules?.knowledge;
if (existing && !existing.localRuntime) throw Error('An existing knowledge binding is configured. Keep it, or explicitly remove it before provisioning local KM.');
const directory = resolve(options['data-directory'] || existing?.localRuntime?.dataDirectory || join(pilotHome, 'knowledge'));
const venv = join(directory, 'venv');
const python = existing?.localRuntime?.python || join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function run(command, commandArgs, extra = {}) {
  const child = spawn(command, commandArgs, { cwd: repo, env, stdio: 'inherit', ...extra });
  const forward = signal => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    await new Promise((resolveRun, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 || signal === 'SIGINT' ? resolveRun() : reject(Error(`${command} exited ${code ?? signal}`)));
    });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

await mkdir(directory, { recursive: true });
if (!existsSync(python) || options['km-package']) {
  const packagePath = options['km-package'] || process.env.PILOTDECK_KM_PACKAGE;
  if (!packagePath || !existsSync(resolve(packagePath)))
    throw Error('First install requires --km-package /absolute/path/to/knowledge_core.whl (or the self-contained source directory). Python >=3.11 is required; Docker is not used.');
  if (!existsSync(python)) await run(options.python || 'python3', ['-m', 'venv', venv]);
  await run(python, ['-m', 'pip', 'install', resolve(packagePath)]);
}
await run(python, ['-c', 'import sys; from importlib.resources import files; assert sys.version_info >= (3,11); assert files("knowledge_core").joinpath("ui/index.html").is_file(), "Build the KM UI before installation"']);
let binding = existing;
if (!binding) {
  const port = Number(options.port || 18891);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid KM port');
  const moduleConfig = join(directory, 'configuration.json');
  if (!existsSync(moduleConfig)) await writeFile(moduleConfig, JSON.stringify({ preset: 'full', modules: { authentication: false, publication: false } }, null, 2) + '\n', { flag: 'wx' });
  // Existing local users are selected by ID; a fresh no-login PD creates ID 1.
  const configuredDatabase = config.webui?.runtime?.databasePath;
  const authDbValue = configuredDatabase || process.env.DATABASE_PATH || join(pilotHome, 'auth.db');
  const authDb = resolve(authDbValue.startsWith('~/') ? join(homedir(), authDbValue.slice(2)) : authDbValue);
  let userId = options['user-id'];
  if (!userId && existsSync(authDb)) {
    const Database = createRequire(new URL('../ui/package.json', import.meta.url))('better-sqlite3');
    const db = new Database(authDb, { readonly: true });
    try { userId = String(db.prepare('SELECT id FROM users WHERE is_active = 1 ORDER BY id LIMIT 1').get()?.id || ''); }
    finally { db.close(); }
  }
  binding = { enabled: true, implementationId: 'knowledge-core', frontendModule: 'knowledge-core',
    contract: 'knowledge-core/v1', transport: 'rest-http-v1', endpoint: `http://127.0.0.1:${port}`,
    pilotDeckUserId: userId || '1', spaceId: 'local', spaces: [{ id: 'local', name: 'Local knowledge' }],
    methods: [...KNOWLEDGE_CORE_METHODS], agentMethods: ['query'],
    localRuntime: { python, dataDirectory: directory, configFile: moduleConfig },
  };
  const runtime = await startLocalKnowledgeRuntime(binding, { env });
  try {
    const response = await fetch(new URL('/api/km/v1/spaces', binding.endpoint));
    if (!response.ok) throw Error(`Cannot provision local KM space: ${response.status}`);
    if (!(await response.json()).some(row => row.id === 'local')) {
      const created = await fetch(new URL('/api/km/v1/spaces', binding.endpoint), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'local', name: 'Local knowledge' }) });
      if (!created.ok) throw Error(`Cannot create local KM space: ${created.status}`);
    }
  } finally { await runtime.stop(); }
  await mkdir(dirname(configPath), { recursive: true });
  // Preserve the original YAML and its comments before adding the binding.
  if (existsSync(configPath)) await writeFile(configPath + `.before-local-km-${Date.now()}`, await readFile(configPath), { flag: 'wx', mode: 0o600 });
  config.modules = { ...config.modules, knowledge: binding };
  await writeFile(configPath, stringify(config), { mode: 0o600 });
}
console.log(`[knowledge] Config: ${configPath}\n[knowledge] Data: ${directory}\n[knowledge] Agent defaults to query only`);
if (!options.prepareOnly) {
  const marker = join(directory, 'pd-ui-prepared.json');
  if (!existsSync(marker) || !existsSync(join(repo, 'ui/dist/index.html'))) {
    await run(process.execPath, ['scripts/generate-frontend-modules.mjs']);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web']);
    await writeFile(marker, JSON.stringify({ preparedAt: new Date().toISOString(), configPath }) + '\n');
  }
  await run(process.execPath, ['ui/server/webRuntimeSupervisor.js', 'start-built']);
}
