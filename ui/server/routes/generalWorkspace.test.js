// @vitest-environment node
import express from 'express';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root, server, base, configPath, profile;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-workspace-api-'));
  profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  configPath = path.join(profile, 'pilotdeck.yaml');
  await fs.writeFile(configPath, stringify({ customEnv: { KEEP_SETTING: 'keep-me' }, webui: { runtime: { workspacesRoot: path.join(root, 'projects') } } }));
  vi.stubEnv('PILOT_HOME', profile);
  vi.stubEnv('PILOTDECK_GENERAL_WORKSPACE_DIRECTORY', '');
  vi.stubEnv('PILOTDECK_GENERAL_WORKSPACE_ID', '');
  vi.stubEnv('PILOTDECK_DOCUMENTS_DIRECTORY', path.join(root, 'Documents'));
  vi.resetModules();
  const { default: router } = await import('./generalWorkspace.js');
  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  vi.unstubAllEnvs();
  if (root) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function put(directory) {
  const response = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) });
  return { status: response.status, body: await response.json() };
}

it('reuses a directory configured directly in YAML after files are created and settings reload', async () => {
  const directory = path.join(root, 'manual YAML 中文');
  const yaml = stringify({ customEnv: { KEEP_SETTING: 'keep-me' }, webui: { runtime: { generalWorkspaceDirectory: directory } } });
  await fs.writeFile(configPath, yaml);
  expect(await (await fetch(base)).json()).toMatchObject({ effectiveDirectory: directory, unavailable: false });
  await fs.writeFile(path.join(directory, 'first-turn.txt'), 'user output');
  expect(await (await fetch(base)).json()).toMatchObject({ effectiveDirectory: directory, unavailable: false });
  const { buildRuntimeEnv, readPilotDeckConfigFile } = await import('../services/pilotdeckConfig.js');
  const { ensureGeneralWorkspaceDirectory } = await import('../utils/generalWorkspace.js');
  const freshEnvironment = { ...process.env, ...buildRuntimeEnv(readPilotDeckConfigFile().config) };
  expect(freshEnvironment.PILOTDECK_GENERAL_WORKSPACE_ID).toBe('');
  expect(await ensureGeneralWorkspaceDirectory(freshEnvironment)).toBe(directory);
  expect(await fs.readFile(configPath, 'utf8')).toBe(yaml);
  expect(await fs.readFile(path.join(directory, 'first-turn.txt'), 'utf8')).toBe('user output');
});

it('persists the exact folder, preserves unrelated config, reloads it and resets the effective cwd', async () => {
  const initial = await (await fetch(base)).json();
  expect(initial.directory).toBe('');
  expect(initial.effectiveDirectory).toBe(path.join(root, 'projects', 'PilotDeckGeneral'));
  const custom = path.join(root, '文档 自定义目录');
  const saved = await put(custom);
  expect(saved.status).toBe(200);
  expect(saved.body.effectiveDirectory).toBe(custom);
  expect((await fs.stat(custom)).isDirectory()).toBe(true);
  expect(process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY).toBe(custom);
  expect((await (await fetch(base)).json()).directory).toBe(custom);
  const config = parse(await fs.readFile(configPath, 'utf8'));
  expect(config.webui.runtime.generalWorkspaceDirectory).toBe(custom);
  expect(config.customEnv.KEEP_SETTING).toBe('keep-me');
  await fs.writeFile(path.join(custom, 'keep.txt'), 'existing file');
  const reset = await put('');
  expect(reset.status).toBe(200);
  expect(reset.body.effectiveDirectory).toBe(initial.defaultDirectory);
  expect(process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY).toBe('');
  expect(await fs.readFile(path.join(custom, 'keep.txt'), 'utf8')).toBe('existing file');
});

it('does not persist invalid, unsafe or non-directory destinations', async () => {
  const original = await fs.readFile(configPath, 'utf8');
  const file = path.join(root, 'file.txt'); await fs.writeFile(file, 'file');
  for (const directory of [42, null, 'relative/path', profile, path.join(profile, 'workspace'), root, file]) {
    expect((await put(directory)).status).toBe(400);
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  }
  expect(process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY).toBe('');
});

it('refuses a redirected destination without writing inside the profile', async () => {
  const link = path.join(root, 'linked');
  await fs.symlink(profile, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await put(path.join(link, 'child'));
  expect(result).toMatchObject({ status: 400, body: { code: 'GENERAL_WORKSPACE_UNSAFE' } });
  expect(await fs.readdir(profile)).toEqual(['pilotdeck.yaml']);
});

it('refuses occupied destinations including dotfiles, permits the current folder and refuses a populated reset target', async () => {
  const initial = await (await fetch(base)).json();
  await fs.writeFile(path.join(initial.effectiveDirectory, 'old-report.md'), 'keep default files');
  const custom = path.join(root, 'custom');
  expect((await put(custom)).status).toBe(200);
  await fs.writeFile(path.join(custom, 'new-report.md'), 'keep custom files');
  expect((await put(custom)).status).toBe(200);
  const occupied = path.join(root, 'occupied'); await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, '.hidden'), 'existing hidden file');
  for (const directory of [occupied, '']) {
    expect(await put(directory)).toMatchObject({ status: 400, body: { code: 'GENERAL_WORKSPACE_NOT_EMPTY' } });
    expect(process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY).toBe(custom);
    expect(parse(await fs.readFile(configPath, 'utf8')).webui.runtime.generalWorkspaceDirectory).toBe(custom);
  }
  expect(await fs.readFile(path.join(initial.effectiveDirectory, 'old-report.md'), 'utf8')).toBe('keep default files');
  expect(await fs.readFile(path.join(custom, 'new-report.md'), 'utf8')).toBe('keep custom files');
});

it('reports a damaged directory identity and permits recovery into a new empty folder', async () => {
  const initial = await (await fetch(base)).json();
  await fs.writeFile(path.join(initial.effectiveDirectory, '.pilotdeck-workspace'), 'damaged identity');
  expect((await (await fetch(base)).json()).unavailable).toBe(true);
  const recovered = await put(path.join(root, 'recovered'));
  expect(recovered.status).toBe(200);
  expect(recovered.body.effectiveDirectory).toBe(path.join(root, 'recovered'));
  expect(recovered.body.unavailable).toBe(false);
  expect(await fs.readFile(path.join(initial.effectiveDirectory, '.pilotdeck-workspace'), 'utf8')).toBe('damaged identity');
});

it.each(['missing', 'replaced'])('allows explicit reselection of an empty folder with a %s marker while startup rejects its stale claim', async marker => {
  const first = path.join(root, 'A');
  const second = path.join(root, 'B');
  expect((await put(first)).status).toBe(200);
  const originalId = parse(await fs.readFile(configPath, 'utf8')).webui.runtime.generalWorkspaceId;
  expect((await put(second)).status).toBe(200);
  await fs.rm(first, { recursive: true });
  await fs.mkdir(first);
  if (marker === 'replaced') await fs.writeFile(path.join(first, '.pilotdeck-workspace'), JSON.stringify({ product: 'PilotDeck', version: 1, id: 'replacement-identity' }));
  const { ensureGeneralWorkspaceDirectory } = await import('../utils/generalWorkspace.js');
  const startup = { ...process.env, PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: first, PILOTDECK_GENERAL_WORKSPACE_ID: '' };
  await expect(ensureGeneralWorkspaceDirectory(startup)).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_STATE_INVALID' });
  const selected = await put(first);
  expect(selected).toMatchObject({ status: 200, body: { effectiveDirectory: first, unavailable: false } });
  const newId = parse(await fs.readFile(configPath, 'utf8')).webui.runtime.generalWorkspaceId;
  expect(newId).not.toBe(originalId);
  await fs.writeFile(path.join(first, 'output.txt'), 'next turn');
  expect(await ensureGeneralWorkspaceDirectory({ ...startup })).toBe(first);
  expect((await (await fetch(base)).json()).unavailable).toBe(false);
  expect((await put(second)).status).toBe(200);
  await fs.rm(first, { recursive: true });
  await fs.mkdir(first);
  await fs.writeFile(path.join(first, '.hidden'), 'replacement user data');
  expect(await put(first)).toMatchObject({ status: 400, body: { code: 'GENERAL_WORKSPACE_NOT_EMPTY' } });
  expect(parse(await fs.readFile(configPath, 'utf8')).webui.runtime.generalWorkspaceDirectory).toBe(second);
  await expect(ensureGeneralWorkspaceDirectory({ ...startup })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_STATE_INVALID' });
  expect(await fs.readdir(first)).toEqual(['.hidden']);
});
