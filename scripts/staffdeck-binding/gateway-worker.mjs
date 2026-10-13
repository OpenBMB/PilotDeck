import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [pd, qa, home, root, proxy] = process.argv.slice(2);
const env = { ...process.env, ...JSON.parse(readFileSync(join(qa, 'env.json'))), PILOT_HOME: home };
const { ensureProjectBinding } = await import(pathToFileURL(join(pd, 'dist/src/pilot/staffdeck/projectBinding.js')));
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
const transport = new GatewayTransport({ url: proxy || env.PILOTDECK_GATEWAY_URL,
  token: readFileSync(join(qa, 'home/server-token'), 'utf8').trim(), clientName: 'test' });
try {
  await transport.connect();
  const value = await ensureProjectBinding(root, { env, activate: async () => {
    await transport.request('reload_extensions', { projectKey: root });
  } });
  console.log(JSON.stringify(value));
} finally { transport.close(); }
