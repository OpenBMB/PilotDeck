// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAC_APP_NAME, MAC_HOST_ID, MAC_DEV_HOST_ID, resolveMacRuntime } from '../../../scripts/lib/mac-computer-use.mjs';
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-install-test-')); directories.push(directory);
  const make = (name, data) => {
    const app = path.join(directory, name, MAC_APP_NAME);
    const binary = path.join(app, 'Contents/MacOS/cua-driver');
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, JSON.stringify(data));
    return { app, binary };
  };
  const inspect = async (app, version, { allowDevelopment = false } = {}) => {
    const binary = path.join(app, 'Contents/MacOS/cua-driver');
    const data = JSON.parse(fs.readFileSync(binary));
    if (data.version !== version || data.invalid || (!data.production && !allowDevelopment)) throw new Error('Signature/version mismatch');
    return { ...data, binary, bundleId: data.production ? MAC_HOST_ID : MAC_DEV_HOST_ID };
  };
  return { directory, root: path.join(directory, 'shared'), make, inspect };
}
it('web and desktop resolve the same production payload outside their source app, without modifying either source', async () => {
  const f = setup(); const production = f.make('Desktop.app/Contents/runtime', { version: '0.34.1', production: true });
  const development = f.make('repo', { version: '0.34.1', production: false });
  const opts = { root: f.root, version: '0.34.1', inspect: f.inspect, installedApps: [] };
  const desktop = await resolveMacRuntime({ ...opts, binary: production.binary });
  const web = await resolveMacRuntime({ ...opts, binary: development.binary });
  expect(web.binary).toBe(desktop.binary); expect(web.bundleId).toBe(MAC_HOST_ID);
  expect(web.app).not.toContain('Desktop.app/');
  expect(fs.readFileSync(web.binary, 'utf8')).toBe(fs.readFileSync(production.binary, 'utf8'));
  expect(JSON.parse(fs.readFileSync(development.binary)).production).toBe(false);
});
it('concurrent installations coalesce on an immutable payload and newer versions leave the old executable intact', async () => {
  const f = setup(); const first = f.make('v1', { version: '0.34.1', production: true });
  const opts = { root: f.root, version: '0.34.1', inspect: f.inspect, installedApps: [], binary: first.binary };
  const [a, b] = await Promise.all([resolveMacRuntime(opts), resolveMacRuntime(opts)]);
  expect(a.binary).toBe(b.binary); const contents = fs.readFileSync(a.binary, 'utf8');
  const next = f.make('v2', { version: '0.34.2', production: true });
  const newer = await resolveMacRuntime({ ...opts, binary: next.binary, version: '0.34.2' });
  expect(newer.binary).not.toBe(a.binary); expect(fs.readFileSync(a.binary, 'utf8')).toBe(contents);
});
it('rejects altered installed payloads rather than overwriting a running component', async () => {
  const f = setup(); const source = f.make('source', { version: '0.34.1', production: true });
  const opts = { root: f.root, version: '0.34.1', inspect: f.inspect, installedApps: [], binary: source.binary };
  const runtime = await resolveMacRuntime(opts); fs.writeFileSync(runtime.binary, 'tampered');
  await expect(resolveMacRuntime(opts)).rejects.toThrow('integrity');
  expect(fs.readFileSync(runtime.binary, 'utf8')).toBe('tampered');
});
it('keeps development identities separate and refuses signed candidates with a different version', async () => {
  const f = setup(); const prod = f.make('prod', { version: '0.34.2', production: true });
  const opts = { root: f.root, inspect: f.inspect, installedApps: [] };
  await resolveMacRuntime({ ...opts, binary: prod.binary, version: '0.34.2' });
  const dev = f.make('dev', { version: '0.34.1', production: false });
  const runtime = await resolveMacRuntime({ ...opts, binary: dev.binary, version: '0.34.1' });
  expect(runtime.bundleId).toBe(MAC_DEV_HOST_ID); expect(runtime.app).toContain('/development/');
  const invalid = f.make('invalid', { version: '0.34.1', production: true, invalid: true });
  await expect(resolveMacRuntime({ ...opts, binary: invalid.binary, version: '0.34.1' })).rejects.toThrow('Signature');
});
