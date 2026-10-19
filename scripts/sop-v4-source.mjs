import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [action, directory] = process.argv.slice(2);
if (!directory) throw Error('Usage: node scripts/sop-v4-source.mjs prepare|start|stop|status /deployment/directory');
const root = resolve(directory);
const metadataPath = join(root, 'deployment.json');
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
const flags = process.argv.slice(4);
const option = name => { const index = flags.indexOf(name); return index < 0 ? undefined : flags[index + 1]; };
async function run(command, args, options = {}) {
  const child = spawn(command, args, { env: cleanEnv, stdio: 'inherit', ...options });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw Error(`${command} exited ${code}`);
}
async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const value = server.address().port;
  await new Promise(done => server.close(done));
  return value;
}
if (action === 'prepare') {
  const began = performance.now();
  const stages = {};
  if (!process.env.SOP_V4_MODEL_CONFIG) throw Error('Set SOP_V4_MODEL_CONFIG to private model YAML');
  try { await access(root); throw Error('Directory must be new'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of ['', 'home', 'workspace', 'logs', 'runtime-data']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const original = YAML.parse(await readFile(process.env.SOP_V4_MODEL_CONFIG, 'utf8'));
  const template = option('--profile') ? YAML.parse(await readFile(resolve(option('--profile')), 'utf8')) : undefined;
  const interactionProfile = template?.agent?.interactionProfile ?? (flags.includes('--without-web') ? 'headless' : 'interactive');
  if (!['interactive', 'headless', 'disabled'].includes(interactionProfile)) throw Error('Invalid agent.interactionProfile');
  const config = { ...template, schemaVersion: 1, agent: { model: original.agent.model, interactionProfile }, model: original.model,
    modules: Object.fromEntries(['agentLoop', 'tools', 'context', 'skills', 'modelProvider'].map(name => [name, { enabled: true, provider: 'pilotdeck' }])) };
  Object.assign(config.modules, template?.modules);
  const ports = { web: await port(), gateway: await port(), runtime: await port(), knowledge: await port() };
  const managed = { sop: template ? template.modules?.sop?.enabled === true && template.modules.sop.localRuntime?.enabled === true : true,
    knowledge: template?.modules?.knowledge?.enabled === true && !!template.modules.knowledge.localRuntime };
  config.modules.sop ??= { enabled: true, implementationId: 'portable-sop', hostAdapter: 'pilotdeck', contract: 'sop.lifecycle/v4',
    transport: 'sop-http-v4', credentialEnv: 'SOP_V4_HOST_TOKEN', approval: { provider: 'pilotdeck' } };
  config.modules.knowledge ??= { enabled: false };
  if (option('--approval-provider')) config.modules.sop.approval = { provider: option('--approval-provider') };
  if (managed.sop) Object.assign(config.modules.sop, { endpoint: `http://127.0.0.1:${ports.runtime}`,
    localRuntime: { enabled: true, python: join(root, 'venv/bin/python'), dataDirectory: join(root, 'runtime-data'),
      maxConcurrency: template?.modules?.sop?.localRuntime?.maxConcurrency ?? 32 } });
  if (managed.knowledge) Object.assign(config.modules.knowledge, { endpoint: `http://127.0.0.1:${ports.knowledge}`,
    localRuntime: { python: join(root, 'venv/bin/python'), dataDirectory: join(root, 'knowledge-data'), configFile: join(root, 'knowledge.json'),
      modelConfig: join(root, 'knowledge-model.json') } });
  await writeFile(join(root, 'home/pilotdeck.yaml'), YAML.stringify(config), { mode: 0o600 });
  const preparedSecrets = { host: randomBytes(32).toString('hex'), gateway: randomBytes(32).toString('hex'), knowledge: randomBytes(32).toString('hex') };
  await writeFile(join(root, 'private.json'), JSON.stringify(preparedSecrets), { mode: 0o600 });
  await writeFile(metadataPath, JSON.stringify({ root, repo, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    node: process.execPath, python: join(root, 'venv/bin/python'), ports, managed, web: !flags.includes('--without-web') }, null, 2));
  await run(process.env.SOP_SOURCE_PYTHON ?? 'python3', ['-m', 'venv', join(root, 'venv')]);
  const installationBegan = performance.now();
  if (managed.sop) await run(join(root, 'venv/bin/python'), ['-m', 'pip', 'install', '-e', join(repo, 'packages/sop-runtime')]);
  if (managed.knowledge) {
    const source = option('--knowledge-package') ?? process.env.PILOTDECK_KM_PACKAGE;
    if (!source) throw Error('Managed KM prepare requires --knowledge-package /path/to/knowledge_core');
    await run(join(root, 'venv/bin/python'), ['-m', 'pip', 'install', resolve(source)]);
    await writeFile(join(root, 'knowledge.json'), JSON.stringify({ preset: 'full', modules: { authentication: true, publication: false } }));
    await writeFile(join(root, 'knowledge-identities.json'), JSON.stringify({ [preparedSecrets.knowledge]: {
      id: 'pilotdeck', tenant_id: config.modules.knowledge.namespace,
      spaces: (config.modules.knowledge.spaces ?? []).map(space => space.id), permissions: ['read', 'write'],
    } }), { mode: 0o600 });
    config.modules.knowledge.localRuntime.identityFile = join(root, 'knowledge-identities.json');
    await writeFile(join(root, 'home/pilotdeck.yaml'), YAML.stringify(config), { mode: 0o600 });
    const [provider, ...model] = original.agent.model.split('/');
    const value = original.model.providers[provider];
    const credential = value.apiKey?.replace(/^\$\{([^}]+)\}$/, (_match, key) => process.env[key] ?? '');
    await writeFile(join(root, 'knowledge-model.json'), JSON.stringify({ model: model.join('/'), base_url: value.url, api_key: credential }), { mode: 0o600 });
  }
  stages.pythonInstallMs = performance.now() - installationBegan;
  if (flags.includes('--build')) {
    const nodeBegan = performance.now();
    await run('pnpm', ['build'], { cwd: repo });
    stages.nodeBuildMs = performance.now() - nodeBegan;
    if (!flags.includes('--without-web')) {
      const webBegan = performance.now();
      await run('pnpm', ['--dir', 'ui', 'run', 'build'], { cwd: repo, env: {
        ...cleanEnv, PILOTDECK_CONFIG_PATH: join(root, 'home/pilotdeck.yaml'),
        PILOTDECK_FRONTEND_PROFILE: join(root, 'home/pilotdeck.yaml'), PILOTDECK_DISABLE_LOCAL_AUTH: '0',
      } });
      stages.webBuildMs = performance.now() - webBegan;
    }
  }
  await writeFile(join(root, 'prepare-timing.json'), JSON.stringify({ elapsedMs: performance.now() - began, stages,
    includes: 'venv, selected Python packages, optional --build Node/Web; Node dependencies must already be installed' }));
  console.log(`Prepared ${root}`);
} else {
  const meta = JSON.parse(await readFile(metadataPath, 'utf8'));
  const secrets = JSON.parse(await readFile(join(root, 'private.json'), 'utf8'));
  if (!secrets.knowledge) { secrets.knowledge = randomBytes(32).toString('hex'); await writeFile(join(root, 'private.json'), JSON.stringify(secrets), { mode: 0o600 }); }
  const config = YAML.parse(await readFile(join(root, 'home/pilotdeck.yaml'), 'utf8'));
  const managed = meta.managed ?? { sop: true, knowledge: false };
  const env = { ...cleanEnv, PILOT_HOME: join(root, 'home'), DATABASE_PATH: join(root, 'home/auth.db'),
    PILOTDECK_CONFIG_PATH: join(root, 'home/pilotdeck.yaml'), NODE_ENV: 'production', PILOTDECK_DISABLE_LOCAL_AUTH: '0',
    HOST: '127.0.0.1', SERVER_PORT: String(meta.ports.web), PILOTDECK_GATEWAY_PORT: String(meta.ports.gateway),
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${meta.ports.gateway}/ws`,
    SOP_V4_DB: join(root, 'runtime-data/runtime.sqlite'), SOP_SOURCE_ROOT: root,
    PILOTDECK_SOP_MANAGED_EXTERNALLY: '1', PILOTDECK_KM_MANAGED_EXTERNALLY: '1',
    SOP_V4_MAX_CONCURRENCY: String(config.modules?.sop?.localRuntime?.maxConcurrency ?? 32) };
  delete env.PILOTDECK_SOP_V4_ENDPOINT;
  if (managed.sop) { env[config.modules.sop.credentialEnv ?? 'SOP_V4_HOST_TOKEN'] = secrets.host; env.SOP_V4_HOST_TOKEN = secrets.host; }
  if (managed.knowledge && config.modules.knowledge.credentialEnv) env[config.modules.knowledge.credentialEnv] = secrets.knowledge;
  if (!meta.managed) env.PILOTDECK_SOP_V4_ENDPOINT = `http://127.0.0.1:${meta.ports.runtime}`;
  let pids = {};
  let pidWrites = Promise.resolve();
  try { pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')); } catch {}
  function live(name) {
    const pid = pids[name];
    if (!pid) return false;
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      return name === 'runtime' ? command.includes(`--port ${meta.ports.runtime}`) && command.includes('staffdeck_sop_runtime.execution_api_v4:app_factory') : command.includes(meta.repo) && (name !== 'knowledge' || command.includes(root));
    } catch { return false; }
  }
  async function start(name, command, args) {
    if (live(name)) throw Error(`${name} already running`);
    const fd = openSync(join(root, 'logs', `${name}.log`), 'a', 0o600);
    const child = spawn(command, args, { cwd: meta.repo, env, detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    child.unref(); closeSync(fd); pids[name] = child.pid;
    pidWrites = pidWrites.then(() => writeFile(join(root, 'pids.json'), JSON.stringify(pids)));
    await pidWrites;
  }
  async function ready(url, check = () => true, component) {
    for (let i = 0; i < 150; i++) {
      if (component) {
        try { process.kill(pids[component], 0); }
        catch { throw Error(`${component} exited during startup; inspect ${root}/logs/${component}.log`); }
      }
      try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.ok && check(await response.json())) return; } catch {}
      await new Promise(done => setTimeout(done, 50));
    }
    throw Error(`Readiness timeout: ${url}; inspect ${root}/logs`);
  }
  async function stopNames(names) {
    for (const name of names) {
      if (!live(name)) continue;
      process.kill(pids[name], 'SIGTERM');
      for (let i = 0; i < 80 && live(name); i++) await new Promise(done => setTimeout(done, 50));
      if (live(name)) process.kill(pids[name], 'SIGKILL');
    }
  }
  if (action === 'start') {
    const began = performance.now(), timings = {}, started = [];
    const launch = async (name, command, args) => { await start(name, command, args); started.push(name); };
    try {
      const results = await Promise.allSettled([
        (async () => {
          if (managed.sop) await launch('runtime', meta.python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.execution_api_v4:app_factory', '--factory', '--host', '127.0.0.1', '--port', String(meta.ports.runtime)]);
          if (config.modules.sop?.enabled) await ready(`${config.modules.sop.endpoint}/healthz`, health => health.contract === 'sop.lifecycle/v4', managed.sop ? 'runtime' : undefined);
          timings.sopReadyMs = performance.now() - began;
        })(),
        (async () => {
          if (managed.knowledge) {
            await unlink(join(root, 'knowledge-ready.json')).catch(() => {});
            await launch('knowledge', meta.node, [join(meta.repo, 'scripts/sop-v4-source-knowledge.mjs'), root]);
            for (let i = 0; ; i++) {
              try { const marker = JSON.parse(await readFile(join(root, 'knowledge-ready.json'), 'utf8')); if (marker.pid === pids.knowledge) break; } catch {}
              try { process.kill(pids.knowledge, 0); }
              catch { throw Error(`knowledge exited during startup; inspect ${root}/logs/knowledge.log`); }
              if (i >= 150) throw Error(`KM initialization timeout; inspect ${root}/logs/knowledge.log`);
              await new Promise(done => setTimeout(done, 50));
            }
          }
          if (config.modules.knowledge?.enabled) await ready(`${config.modules.knowledge.endpoint}/api/km/config`, health => health.api_protocol === 'knowledge-core/v1');
          timings.knowledgeReadyMs = performance.now() - began;
        })(),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      if (flags.includes('--services-only')) {
        timings.totalMs = performance.now() - began;
        await writeFile(join(root, 'start-timing.json'), JSON.stringify(timings));
        console.log(JSON.stringify({ servicesOnly: true, root, timings }));
        process.exit(0);
      }
      await launch('gateway', meta.node, [join(meta.repo, 'scripts/sop-v4-source-gateway.mjs')]);
      await ready(`http://127.0.0.1:${meta.ports.gateway}/health`, () => true, 'gateway');
      const { createPilotDeckClient } = await import('../dist/packages/sdk/src/index.js');
      const sdk = createPilotDeckClient({ gatewayUrl: `ws://127.0.0.1:${meta.ports.gateway}/ws`, authToken: secrets.gateway, projectKey: join(root, 'workspace') });
      try { await sdk.connect(); if (config.modules.sop?.enabled) await sdk.sop.call('sop_status', { runId: '0'.repeat(32) }).catch(error => {
        if (error.code !== 'sop_run_not_found' && !/not.found|SOP_RUN_NOT_FOUND/i.test(String(error))) throw error;
      }); } finally { await sdk.close(); }
      timings.gatewayReadyMs = performance.now() - began;
      if (meta.web !== false) {
        await launch('web', meta.node, ['--import', 'tsx', join(meta.repo, 'ui/server/index.js')]);
        await ready(`http://127.0.0.1:${meta.ports.web}/health`, () => true, 'web');
        timings.webReadyMs = performance.now() - began;
      }
      timings.totalMs = performance.now() - began;
      await writeFile(join(root, 'start-timing.json'), JSON.stringify(timings));
    } catch (error) { await stopNames(started.reverse()); throw error; }
  } else if (action === 'stop') {
    await stopNames(['web', 'gateway', 'knowledge', 'runtime']);
    await unlink(join(root, 'pids.json')).catch(() => {});
  } else if (action !== 'status') throw Error('Unknown action');
  console.log(JSON.stringify({ root, revision: meta.revision, running: Object.fromEntries(['web', 'gateway', 'knowledge', 'runtime'].map(name => [name, live(name)])),
    web: meta.web === false ? null : `http://127.0.0.1:${meta.ports.web}`, gateway: `ws://127.0.0.1:${meta.ports.gateway}/ws`, runtime: config.modules.sop?.endpoint }));
}
