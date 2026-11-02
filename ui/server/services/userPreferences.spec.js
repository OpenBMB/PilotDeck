import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfiguration, writeConfiguration } from '@pilotdeck/config';
import { createUserPreferences, userConfigurationDirectory } from './userPreferences.js';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function home() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-preferences-')); directories.push(directory); return directory; }
it('imports old browser preferences once, preserves YAML and persists native readable values', () => {
  const store = createUserPreferences(1, home());
  store.update({ themeMode: 'dark', uiPreferences: '{"showThinking":false}', codeEditorFontSize: '18' }, true);
  store.update({ themeMode: 'light' }, true);
  expect(store.read()).toMatchObject({ themeMode: 'dark', uiPreferences: '{"showThinking":false}', codeEditorFontSize: '18' });
  expect(readConfiguration(store.file).value.values).toEqual({ themeMode: 'dark', uiPreferences: { showThinking: false }, codeEditorFontSize: 18 });
  store.update({ themeMode: 'light', codeEditorFontSize: null });
  expect(store.read()).toEqual({ themeMode: 'light', uiPreferences: '{"showThinking":false}' });
});
it('isolates users, rejects auth/cache keys and traversal, and recovers a damaged field', () => {
  const directory = home(), a = createUserPreferences(1, directory), b = createUserPreferences(2, directory);
  a.update({ themeMode: 'dark' });
  expect(b.read()).toEqual({});
  expect(() => a.update({ 'auth-token': 'secret' })).toThrow('Invalid preference');
  expect(() => userConfigurationDirectory('../escape', directory)).toThrow();
  writeConfiguration(a.file, { values: { themeMode: 'broken', codeEditorFontSize: -10, userLanguage: 'en', 'auth-token': 'secret' }, jsonKeys: ['codeEditorFontSize'] });
  expect(a.read()).toEqual({ userLanguage: 'en' });
});
