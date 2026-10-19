import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import YAML from 'yaml';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !process.env.SOP_V4_MODEL_CONFIG) throw Error('Usage: SOP_V4_MODEL_CONFIG=/private/config node scripts/deploy-sop-v4.mjs /new/deployment/directory');
try { await access(root); throw Error('Deployment directory already exists; use its compose.yaml to manage it'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const directory of ['', 'home', 'workspace', 'runtime-data']) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
const source = join(repository, 'scripts/sop-v4-deployment');
for (const file of ['compose.yaml', 'Dockerfile.gateway', 'Dockerfile.runtime', 'gateway.mjs']) await cp(join(source, file), join(root, file));
await cp(join(repository, 'dist'), join(root, 'dist'), { recursive: true });
await cp(join(repository, 'ui/server'), join(root, 'web-server'), { recursive: true, filter: path => !/auth\.db(?:-|$)|node_modules/.test(path) });
await cp(join(repository, 'packages/sop-runtime/src'), join(root, 'runtime-source'), { recursive: true });
const config = YAML.parse(await readFile(process.env.SOP_V4_MODEL_CONFIG, 'utf8'));
await writeFile(join(root, 'home/pilotdeck.yaml'), YAML.stringify({ schemaVersion: 1,
  agent: { model: config.agent.model, interactionProfile: 'headless' }, model: config.model }), { mode: 0o600 });
await writeFile(join(root, 'private.env'), `SOP_V4_HOST_TOKEN=${randomBytes(32).toString('hex')}\nPILOTDECK_GATEWAY_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
await writeFile(join(root, '.dockerignore'), 'home\nworkspace\nruntime-data\nprivate.env\nevidence*\nbackup*\nowner-login.json\n', { mode: 0o600 });
// Match the explicit image used by the web service without building it twice.
const compose = YAML.parse(await readFile(join(root, 'compose.yaml'), 'utf8'));
compose.services.gateway.image = 'sop-v4-acceptance-gateway';
await writeFile(join(root, 'compose.yaml'), YAML.stringify(compose));
async function docker(args) {
  const child = spawn('docker', ['compose', '-p', 'sop-v4-acceptance', '-f', join(root, 'compose.yaml'), ...args], { stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw Error(`docker compose exited ${code}`);
}
await docker(['config', '--quiet']);
await docker(['build']);
await docker(['up', '-d', '--wait']);
console.log(JSON.stringify({ deployment: root, web: 'http://127.0.0.1:23314', gateway: 'ws://127.0.0.1:18814/ws', runtime: 'http://127.0.0.1:18914' }));
