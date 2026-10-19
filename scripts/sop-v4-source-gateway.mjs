import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalGateway } from '../dist/src/cli/createLocalGateway.js';
import { startGatewayServer } from '../dist/src/gateway/server/GatewayServer.js';
const root = process.env.SOP_SOURCE_ROOT;
const meta = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
const secrets = JSON.parse(await readFile(join(root, 'private.json'), 'utf8'));
const project = join(root, 'workspace');
await writeFile(join(root, 'home/server-token'), secrets.gateway, { mode: 0o600 });
const local = createLocalGateway({ projectRoot: project, fallbackProjectRoot: project, pilotHome: join(root, 'home'), env: process.env,
  permissionMode: 'bypassPermissions', extraTools: [{ name: 'native_probe', kind: 'custom', description: 'Source acceptance native tool.',
    inputSchema: { type: 'object' }, isReadOnly: () => true, isConcurrencySafe: () => true,
    async execute() { return { content: [{ type: 'text', text: 'NATIVE_TOOL_OK' }] }; } }] });
let server;
try {
  await local.ready;
  server = await startGatewayServer({ gateway: local.gateway, port: meta.ports.gateway, token: secrets.gateway });
} catch (error) { await local.dispose(); throw error; }
await writeFile(join(root, 'gateway-ready.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
console.log(`Source Gateway ready ${server.url}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await server.close(); await local.dispose(); process.exit(0); });
