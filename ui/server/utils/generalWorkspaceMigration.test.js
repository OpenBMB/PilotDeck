import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateLegacyGeneralWorkspace } from './generalWorkspaceMigration.js';

const temporaryRoots = [];
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-general-migration-'));
    temporaryRoots.push(root);
    const options = { source: path.join(root, '用户 general'), destination: path.join(root, '文档 PilotDeck'), pilotHome: path.join(root, 'profile') };
    await Promise.all(Object.values(options).map(directory => fs.mkdir(directory)));
    return options;
}
async function write(directory, name, value) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
}
const read = (directory, name) => fs.readFile(path.join(directory, name), 'utf8');
async function manifests(options) {
    const directory = path.join(options.pilotHome, 'migrations');
    const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await read(directory, file))));
}
afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) {
        expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

it('copies nested files, dotfiles and binary bytes while keeping the legacy copy independent', async () => {
    const options = await fixture();
    await write(options.source, '报告/report.md', 'existing report');
    await write(options.source, '.env', 'fixture only');
    await write(options.source, 'image.bin', Buffer.from([0, 255, 128, 42]));
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, '报告/report.md')).toBe('existing report');
    expect(await read(options.destination, '.env')).toBe('fixture only');
    expect(await fs.readFile(path.join(options.destination, 'image.bin'))).toEqual(Buffer.from([0, 255, 128, 42]));
    await write(options.destination, '报告/report.md', 'new version');
    expect(await read(options.source, '报告/report.md')).toBe('existing report');
    expect(await fs.readdir(options.destination)).not.toContain(expect.stringMatching(/^\.pilotdeck-migration/));
    expect(await manifests(options)).toMatchObject([{ copied: 3, conflicts: [], skipped: [] }]);
});

it('merges both directories without overwriting new files and preserves each differing version', async () => {
    const options = await fixture();
    await write(options.source, 'report.md', 'legacy');
    await write(options.source, 'notes/old.md', 'old only');
    await write(options.source, 'same.md', 'same');
    await write(options.destination, 'report.md', 'new');
    await write(options.destination, 'report (from general).md', 'earlier recovery');
    await write(options.destination, 'notes/new.md', 'new only');
    await write(options.destination, 'same.md', 'same');
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, 'report.md')).toBe('new');
    expect(await read(options.destination, 'report (from general).md')).toBe('earlier recovery');
    expect(await read(options.destination, 'report (from general 2).md')).toBe('legacy');
    expect(await read(options.destination, 'notes/old.md')).toBe('old only');
    expect(await read(options.destination, 'notes/new.md')).toBe('new only');
    expect(await fs.readdir(options.destination)).not.toContain('same (from general).md');
    expect((await manifests(options))[0].conflicts).toEqual([{ source: 'report.md', destination: 'report (from general 2).md' }]);
});

it('preserves file/directory collisions in either direction', async () => {
    const options = await fixture();
    await write(options.source, 'folder/old.txt', 'legacy directory');
    await write(options.destination, 'folder', 'new file');
    await write(options.source, 'data', 'legacy file');
    await write(options.destination, 'data/new.txt', 'new directory');
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, 'folder')).toBe('new file');
    expect(await read(options.destination, 'folder (from general)/old.txt')).toBe('legacy directory');
    expect(await read(options.destination, 'data/new.txt')).toBe('new directory');
    expect(await read(options.destination, 'data (from general)')).toBe('legacy file');
});

it('does not reimport deleted or changed files after successful migration, including across reloads', async () => {
    const options = await fixture();
    await write(options.source, 'report.md', 'old');
    await migrateLegacyGeneralWorkspace(options);
    await fs.unlink(path.join(options.destination, 'report.md'));
    await write(options.source, 'late.md', 'written after migration');
    vi.resetModules();
    const { migrateLegacyGeneralWorkspace: reloaded } = await import('./generalWorkspaceMigration.js');
    await reloaded(options);
    expect(await fs.readdir(options.destination)).toEqual([]);
});

it('can restore legacy files if the destination directory itself was removed', async () => {
    const options = await fixture();
    await write(options.source, 'report.md', 'old');
    await migrateLegacyGeneralWorkspace(options);
    await fs.unlink(path.join(options.destination, 'report.md'));
    await fs.rmdir(options.destination);
    await fs.mkdir(options.destination);
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, 'report.md')).toBe('old');
});

it('shares concurrent migration requests and creates only one conflict copy', async () => {
    const options = await fixture();
    await write(options.source, 'report.md', 'old');
    await write(options.destination, 'report.md', 'new');
    await Promise.all(Array.from({ length: 8 }, () => migrateLegacyGeneralWorkspace(options)));
    expect((await fs.readdir(options.destination)).sort()).toEqual(['report (from general).md', 'report.md']);
    expect(await manifests(options)).toHaveLength(1);
});

it('retries an interrupted migration without publishing partial files or duplicating earlier copies', async () => {
    const options = await fixture();
    await write(options.source, 'a.md', 'first file');
    await write(options.source, 'report.md', 'complete report');
    const physicalDestination = await fs.realpath(options.destination);
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
        if (to === path.join(physicalDestination, 'report.md')) throw Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' });
        return link(from, to);
    });
    await expect(migrateLegacyGeneralWorkspace(options)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await read(options.destination, 'a.md')).toBe('first file');
    expect(await fs.readdir(options.destination)).toEqual(['a.md']);
    expect(await manifests(options)).toEqual([]);
    vi.restoreAllMocks();
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, 'report.md')).toBe('complete report');
    expect((await fs.readdir(options.destination)).sort()).toEqual(['a.md', 'report.md']);
});

it('preserves a new file created concurrently at publication time', async () => {
    const options = await fixture();
    await write(options.source, 'report.md', 'legacy');
    const link = fs.link.bind(fs);
    let raced = false;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
        if (!raced) { raced = true; await fs.writeFile(to, 'new concurrent file', { flag: 'wx' }); }
        return link(from, to);
    });
    await migrateLegacyGeneralWorkspace(options);
    expect(await read(options.destination, 'report.md')).toBe('new concurrent file');
    expect(await read(options.destination, 'report (from general).md')).toBe('legacy');
});

it('does not follow legacy junctions or write through destination junctions', async () => {
    const options = await fixture();
    const outside = path.join(path.dirname(options.source), 'outside');
    await write(outside, 'private.txt', 'outside');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, path.join(options.source, 'external'), linkType);
    await write(options.source, 'notes/report.md', 'legacy notes');
    await fs.symlink(outside, path.join(options.destination, 'notes'), linkType);
    await migrateLegacyGeneralWorkspace(options);
    expect(await fs.readdir(outside)).toEqual(['private.txt']);
    expect(await read(options.destination, 'notes (from general)/report.md')).toBe('legacy notes');
    expect(await fs.lstat(path.join(options.destination, 'external')).catch(error => error.code)).toBe('ENOENT');
    expect((await manifests(options))[0].skipped).toEqual(['external']);
});

it.each(['source', 'destination'])('rejects a junction at the %s root', async field => {
    const options = await fixture();
    const outside = path.join(path.dirname(options.source), 'outside');
    await fs.mkdir(outside);
    await fs.rmdir(options[field]);
    await fs.symlink(outside, options[field], process.platform === 'win32' ? 'junction' : 'dir');
    await expect(migrateLegacyGeneralWorkspace(options)).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
    expect(await fs.readdir(outside)).toEqual([]);
});

it('rejects source/destination overlap and legacy paths exposing the profile', async () => {
    const options = await fixture();
    await expect(migrateLegacyGeneralWorkspace({ ...options, destination: options.source })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
    await expect(migrateLegacyGeneralWorkspace({ ...options, pilotHome: path.dirname(options.source) })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
});

it('does nothing when no legacy workspace exists', async () => {
    const options = await fixture();
    await fs.rmdir(options.source);
    await migrateLegacyGeneralWorkspace(options);
    expect(await fs.readdir(options.pilotHome)).toEqual([]);
});

it('keeps conflict names within filename limits for long Unicode filenames', async () => {
    const options = await fixture();
    const name = '报告'.repeat(35) + '.md';
    await write(options.source, name, 'old');
    await write(options.destination, name, 'new');
    await migrateLegacyGeneralWorkspace(options);
    const recovered = (await fs.readdir(options.destination)).find(file => file !== name);
    expect(Buffer.byteLength(recovered)).toBeLessThan(255);
    expect(await read(options.destination, recovered)).toBe('old');
});

it('preserves read-only files without leaving a Windows read-only staging file', async () => {
    const options = await fixture();
    await write(options.source, 'readonly.md', 'read only');
    await fs.chmod(path.join(options.source, 'readonly.md'), 0o444);
    await migrateLegacyGeneralWorkspace(options);
    expect(await fs.readdir(options.destination)).toEqual(['readonly.md']);
    expect(await read(options.destination, 'readonly.md')).toBe('read only');
    expect((await fs.stat(path.join(options.destination, 'readonly.md'))).mode & 0o222).toBe(0);
});

it.each([false, true])('resolves a redirected parent even when the profile is missing (%s)', async missingProfile => {
    const options = await fixture();
    const root = path.dirname(options.source);
    const alias = path.join(root, 'redirected parent');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    if (missingProfile) await fs.rmdir(options.pilotHome);
    await write(options.source, 'report.md', 'old report');
    const redirected = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.join(alias, path.basename(value))]));
    await migrateLegacyGeneralWorkspace(redirected);
    expect(await read(options.destination, 'report.md')).toBe('old report');
    expect(await manifests(options)).toHaveLength(1);
    expect((await manifests(options))[0].destination).toBe(await fs.realpath(options.destination));
});
