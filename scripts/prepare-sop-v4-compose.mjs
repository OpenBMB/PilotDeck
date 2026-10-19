import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
const source = resolve(process.argv[2]), output = resolve(process.argv[3]);
const config = YAML.parse(await readFile(join(source, 'home/pilotdeck.yaml'), 'utf8'));
const secrets = JSON.parse(await readFile(join(source, 'private.json'), 'utf8'));
const values = { PILOTDECK_API_KEY: secrets.gateway, SOP_V4_HOST_TOKEN: secrets.host, PILOTDECK_KM_SERVICE_TOKEN: secrets.knowledge,
  PILOTDECK_KM_CAPABILITY_TOKEN: secrets.gateway, PILOTDECK_PORT: '63681' };
for (const [id, provider] of Object.entries(config.model.providers)) {
  const key = `ACCEPT_MODEL_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
  values[key] = provider.apiKey;
  provider.apiKey = '${' + key + '}';
}
config.modules.sop.approval = { provider: 'pilotdeck' };
delete config.modules.sop.localRuntime;
delete config.modules.knowledge.localRuntime;
config.modules.sop.endpoint = 'http://sop-runtime:8091';
config.modules.knowledge.endpoint = 'http://knowledge-runtime:8787';
const profile = join(source, 'compose-profile.yaml');
await writeFile(profile, YAML.stringify(config), { mode: 0o600 });
const child = spawn(process.execPath, ['products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs', '--profile', profile,
  '--out', output, '--knowledge-root', process.argv[4]], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
if (code !== 0) throw Error(`Export failed ${code}`);
const quote = value => "'" + String(value).replaceAll("'", "\\'") + "'";
await writeFile(join(output, '.env'), Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
console.log(`Prepared private Compose credentials in ${output}`);
