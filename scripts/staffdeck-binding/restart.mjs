import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa, 'Set BINDING_QA_ROOT');
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck');
const python = process.env.BINDING_QA_PYTHON; assert.ok(python);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const pids = JSON.parse(readFileSync(join(qa, 'pids.json'), 'utf8'));
const port = Number(process.env.BINDING_QA_SD_UPSTREAM_PORT || new URL(env.STAFFDECK_FORMAL_API_ORIGIN).port);
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['sd']) {
  try { process.kill(pids[name], 'SIGTERM'); } catch {}
  for (let i = 0; i < 30; i++) {
    try { process.kill(pids[name], 0); await new Promise(done => setTimeout(done, 100)); }
    catch { break; }
  }
  try { process.kill(pids[name], 0); process.kill(pids[name], 'SIGKILL'); } catch {}
  await new Promise(done => setTimeout(done, 200));
  const common = { ...process.env }; delete common.NODE_OPTIONS;
  let command = process.execPath, args, cwd = pd, values = { ...common, ...env };
  if (name === 'sd') {
    command = python; cwd = sd;
    args = ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)];
    if (process.env.BINDING_QA_OBSERVE_SD_PATH) args = [join(pd, 'scripts/staffdeck-binding/observe-sd.py'), String(port)];
    values = { ...common, PYTHONPATH: `${sd}/backend:${sd}/backend/src`, ULTRARAG_DOTENV: join(qa, 'absent.env'),
      DATABASE_URL: `sqlite:///${qa}/sd.sqlite`, DEMO_SEED_ENABLED: 'false', STARTUP_ORPHAN_CLEANUP_ENABLED: 'false',
      APP_SECRET: 'binding-isolated-acceptance-secret', HARNESS_V3_ROOT: process.env.HARNESS_V3_ROOT,
      HARNESS_V3_HOME: join(qa, 'sd-home'), HARNESS_RUNTIME_CONFIG_PATH: join(qa, 'sd-runtime.json'),
      STAFFDECK_PROJECT_BINDING_ENABLED: env.STAFFDECK_PROJECT_BINDING_ENABLED, PILOTDECK_DOMAIN_HOST_ENABLED: 'true',
      STAFFDECK_COPY_TARGET_AGENT_ID: env.STAFFDECK_COPY_TARGET_AGENT_ID,
      PILOTDECK_APPROVAL_BRIDGE_ENABLED: 'true',
      PILOTDECK_GATEWAY_URL: env.PILOTDECK_GATEWAY_URL, PILOTDECK_GATEWAY_TOKEN_PATH: join(qa, 'home/server-token'),
      PILOTDECK_USER_ID: '1', STAFFDECK_COPY_TENANT_ID: env.STAFFDECK_COPY_TENANT_ID,
      STAFFDECK_COPY_ACTOR_USER_ID: env.STAFFDECK_COPY_ACTOR_USER_ID };
  } else if (name === 'gateway') {
    args = [join(pd, 'dist/src/cli/pilotdeck.js'), 'server', '--port', env.PILOTDECK_GATEWAY_PORT]; cwd = join(qa, 'workspace');
  } else if (name === 'web') args = ['--import', 'tsx', join(pd, 'ui/server/index.js')];
  else throw new Error(`Unsupported process ${name}`);
  const log = openSync(join(qa, `${name}.log`), 'a', 0o600);
  const child = spawn(command, args, { cwd, env: values, detached: true, stdio: ['ignore', log, log] });
  child.unref(); pids[name] = child.pid;
}
writeFileSync(join(qa, 'pids.json'), JSON.stringify(pids));
console.log('Restarted isolated services');
