import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfiguration, writeConfiguration } from '@pilotdeck/config';
import { createYamlConfiguration } from './yamlConfiguration.js';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-secrets-')); directories.push(directory);
  return { directory, file: path.join(directory, 'credentials/web.yaml'), store: createYamlConfiguration({}, () => directory) };
}
it('imports secrets once, retains IDs and does not resurrect a deleted key', () => {
  const { store, file } = fixture();
  const legacy = () => [{ id: 8, user_id: 2, credential_value: 'unchanged-token', is_active: 1 }];
  expect(store.read('credentials', legacy)[0].credential_value).toBe('unchanged-token');
  store.update('credentials', () => [], legacy);
  expect(store.read('credentials', legacy)).toEqual([]);
  const created = store.insert('credentials', { user_id: 2, credential_value: 'new-token' }, legacy);
  expect(created.id).toBe(9);
  expect(readConfiguration(file).value.credentials[0].credential_value).toBe('new-token');
});
it('keeps other sections, restores malformed fields and disables invalid active flags', () => {
  const { store, file } = fixture();
  writeConfiguration(file, { app: { jwt_secret: 'stable-secret', invalid: { secret: 'never-log-me' } }, credentials: [null, { id: 1, user_id: 2, credential_value: 'token', is_active: 'false' }], apiKeys: 'bad' });
  expect(store.read('app', () => ({}))).toEqual({ jwt_secret: 'stable-secret' });
  expect(store.read('credentials')).toEqual([{ id: 1, user_id: 2, credential_value: 'token', is_active: 0 }]);
  expect(store.read('apiKeys')).toEqual([]);
  expect(store.read('app', () => ({})).jwt_secret).toBe('stable-secret');
});
