import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectId } from './pilotPaths.js';

import {
    ensureGeneralWorkspaceDirectory,
    resolveGeneralWorkspaceDirectory,
} from './generalWorkspace.js';

const temporaryRoots = [];
const systemFolders = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: systemFolders.query }));

async function makeTemporaryRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-general-workspace-'));
    temporaryRoots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => (
        fs.rm(root, { recursive: true, force: true })
    )));
});
describe('General workspace isolation', () => {
    it('adopts the previous PilotDeck directory only when existing General history proves an upgrade', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'profile');
        const transcriptDirectory = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats');
        await fs.mkdir(transcriptDirectory, { recursive: true });
        await fs.writeFile(path.join(transcriptDirectory, 'existing.jsonl'), '{"fixture":true}\n');
        const legacy = path.join(root, 'workspaces', 'PilotDeck');
        await fs.mkdir(legacy, { recursive: true });
        await fs.writeFile(path.join(legacy, 'report.md'), 'previous version file');
        const env = { PILOT_HOME: pilotHome, WORKSPACES_ROOT: path.join(root, 'workspaces') };
        expect(await ensureGeneralWorkspaceDirectory(env)).toBe(legacy);
        expect(await ensureGeneralWorkspaceDirectory(env)).toBe(legacy);
        expect(resolveGeneralWorkspaceDirectory(env)).toBe(legacy);
        expect(await fs.readFile(path.join(legacy, 'report.md'), 'utf8')).toBe('previous version file');
        expect(await fs.readdir(path.dirname(legacy))).not.toContain('PilotDeckGeneral');
    });
    it.each(['runtime', 'resources-sibling', 'install-sibling', 'install-root', 'install-parent'])('rejects a custom workspace overlapping the complete desktop installation: %s', async kind => {
        const root = await makeTemporaryRoot();
        const installation = path.join(root, 'application');
        const runtime = path.join(installation, 'resources', 'runtime');
        await fs.mkdir(runtime, { recursive: true });
        const candidate = { runtime, 'resources-sibling': path.join(installation, 'resources', 'user-workspace'),
            'install-sibling': path.join(installation, 'user-workspace'), 'install-root': installation, 'install-parent': root }[kind];
        const env = { PILOT_HOME: path.join(root, 'profile'), PILOTDECK_DESKTOP_RUNTIME_ROOT: runtime,
            PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: candidate };
        await expect(ensureGeneralWorkspaceDirectory(env)).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
        expect(await fs.readdir(runtime)).toEqual([]);
        expect(await fs.readdir(installation)).toEqual(['resources']);
    });
    it.each(['win32', 'darwin', 'linux'])('uses an explicitly configured exact directory on %s', (platform) => {
        const homeDirectory = path.resolve('fixture-user');
        const directory = path.resolve('custom-directory');
        expect(resolveGeneralWorkspaceDirectory({ PILOT_HOME: path.join(homeDirectory, '.pilotdeck'),
            WORKSPACES_ROOT: path.resolve('other-root'), PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: directory }, {
            platform, homeDirectory,
        })).toBe(directory);
        expect(resolveGeneralWorkspaceDirectory({ PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: '~/Custom' }, {
            platform, homeDirectory,
        })).toBe(path.join(homeDirectory, 'Custom'));
    });

    it('rejects relative custom paths and paths containing the profile', () => {
        expect(() => resolveGeneralWorkspaceDirectory({ PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: 'relative' })).toThrow('absolute path');
        const pilotHome = path.resolve('profile');
        for (const directory of [pilotHome, path.join(pilotHome, 'child'), path.dirname(pilotHome)]) {
            expect(() => resolveGeneralWorkspaceDirectory({ PILOT_HOME: pilotHome, PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: directory })).toThrow('separate from PILOT_HOME');
        }
    });

    it('does not import legacy files into a user-selected custom folder', async () => {
        const root = await makeTemporaryRoot();
        await fs.mkdir(path.join(root, 'general'));
        await fs.writeFile(path.join(root, 'general', 'report.md'), 'legacy');
        const result = await ensureGeneralWorkspaceDirectory({ PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: root,
            PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: path.join(root, 'custom') });
        expect(await fs.readdir(result)).toEqual(['.pilotdeck-workspace']);
        expect(await fs.readFile(path.join(root, 'general', 'report.md'), 'utf8')).toBe('legacy');
    });

    it('rejects a linked ancestor before creating a directory in the profile', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'profile');
        await fs.mkdir(pilotHome);
        await fs.symlink(pilotHome, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(ensureGeneralWorkspaceDirectory({ PILOT_HOME: pilotHome,
            PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: path.join(root, 'link', 'must-not-create') })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
        expect(await fs.readdir(pilotHome)).toEqual([]);
    });
    it.each(['win32', 'darwin', 'linux'])('migrates the previous default directory on %s before returning the new cwd', async (platform) => {
        const root = await makeTemporaryRoot();
        const homeDirectory = path.join(root, 'user home');
        const documentsDirectory = path.join(root, 'redirected 文档');
        const pilotHome = path.join(root, 'pilot-home');
        await fs.mkdir(path.join(homeDirectory, 'general'), { recursive: true });
        await fs.writeFile(path.join(homeDirectory, 'general', 'report.md'), 'legacy report');
        const result = await ensureGeneralWorkspaceDirectory({ PILOT_HOME: pilotHome, WORKSPACES_ROOT: homeDirectory }, {
            platform, homeDirectory, documentsDirectory,
        });
        expect(result).toBe(path.join(platform === 'win32' ? documentsDirectory : homeDirectory, 'PilotDeckGeneral'));
        expect(await fs.readFile(path.join(result, 'report.md'), 'utf8')).toBe('legacy report');
        expect(await fs.readFile(path.join(homeDirectory, 'general', 'report.md'), 'utf8')).toBe('legacy report');
    });

    it('merges a custom root with an already populated PilotDeck directory', async () => {
        const root = await makeTemporaryRoot();
        const workspacesRoot = path.join(root, 'custom');
        await fs.mkdir(path.join(workspacesRoot, 'general'), { recursive: true });
        await fs.mkdir(path.join(workspacesRoot, 'PilotDeckGeneral'));
        await fs.writeFile(path.join(workspacesRoot, 'general', 'report.md'), 'legacy');
        await fs.writeFile(path.join(workspacesRoot, 'PilotDeckGeneral', 'report.md'), 'current');
        const result = await ensureGeneralWorkspaceDirectory({ PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: workspacesRoot });
        expect(result).toBe(path.join(workspacesRoot, 'PilotDeckGeneral'));
        expect(await fs.readFile(path.join(result, 'report.md'), 'utf8')).toBe('current');
        expect(await fs.readFile(path.join(result, 'report (from general).md'), 'utf8')).toBe('legacy');
    });

    it.each(['darwin', 'linux'])('defaults to ~/PilotDeckGeneral on %s', (platform) => {
        const homeDirectory = path.resolve('fixture-user');
        expect(resolveGeneralWorkspaceDirectory({ PILOT_HOME: path.join(homeDirectory, '.pilotdeck') }, {
            platform, homeDirectory,
        })).toBe(path.join(homeDirectory, 'PilotDeckGeneral'));
    });

    it.each(['unset', 'tilde', 'absolute'])('uses the Windows Documents folder with the default project root %s', (rootKind) => {
        const homeDirectory = path.resolve('fixture-user');
        const documentsDirectory = path.resolve('redirected-documents');
        const workspacesRoot = rootKind === 'absolute' ? homeDirectory : rootKind === 'tilde' ? '~' : undefined;
        expect(resolveGeneralWorkspaceDirectory({ PILOT_HOME: path.join(homeDirectory, '.pilotdeck'), WORKSPACES_ROOT: workspacesRoot }, {
            platform: 'win32', homeDirectory, documentsDirectory,
        })).toBe(path.join(documentsDirectory, 'PilotDeckGeneral'));
    });

    it('resolves the Windows known Documents folder outside the desktop host', () => {
        const documentsDirectory = path.resolve('system-documents');
        systemFolders.query.mockReturnValue(documentsDirectory + '\r\n');
        expect(resolveGeneralWorkspaceDirectory({}, { platform: 'win32' })).toBe(path.join(documentsDirectory, 'PilotDeckGeneral'));
        expect(systemFolders.query).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ windowsHide: true }));
    });

    it('falls back to ~/Documents if the Windows known-folder query is unavailable', async () => {
        vi.resetModules();
        systemFolders.query.mockImplementation(() => { throw new Error('PowerShell unavailable'); });
        const { resolveGeneralWorkspaceDirectory: resolveFresh } = await import('./generalWorkspace.js');
        const homeDirectory = path.resolve('fixture-user');
        expect(resolveFresh({}, { platform: 'win32', homeDirectory })).toBe(path.join(homeDirectory, 'Documents', 'PilotDeckGeneral'));
    });

    it('creates a managed General directory under WORKSPACES_ROOT', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'pilot-home');
        const workspacesRoot = path.join(root, 'workspaces');
        await fs.mkdir(pilotHome);

        const actual = await ensureGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: workspacesRoot,
        });

        expect(actual).toBe(path.join(workspacesRoot, 'PilotDeckGeneral'));
        expect((await fs.stat(actual)).isDirectory()).toBe(true);
    });

    it('reports a missing registered workspace instead of silently selecting a new directory', async () => {
        const root = await makeTemporaryRoot();
        const env = {
            PILOT_HOME: path.join(root, 'pilot-home'),
            WORKSPACES_ROOT: path.join(root, 'workspaces'),
        };
        await fs.mkdir(env.PILOT_HOME);
        const first = await ensureGeneralWorkspaceDirectory(env);
        await fs.rm(env.WORKSPACES_ROOT, { recursive: true, force: true });

        await expect(ensureGeneralWorkspaceDirectory(env)).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_STATE_INVALID' });
        expect(resolveGeneralWorkspaceDirectory(env)).toBe(first);
    });

    it('rejects workspace roots that would expose PILOT_HOME', () => {
        const pilotHome = '/tmp/pilotdeck-home';
        expect(() => resolveGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: pilotHome,
        })).toThrow('separate from PILOT_HOME');
    });

    it('uses a numbered default instead of a symbolic-link General directory on first launch', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'pilot-home');
        const workspacesRoot = path.join(root, 'workspaces');
        const linkTarget = path.join(root, 'elsewhere');
        await Promise.all([
            fs.mkdir(pilotHome),
            fs.mkdir(workspacesRoot),
            fs.mkdir(linkTarget),
        ]);
        await fs.symlink(linkTarget, path.join(workspacesRoot, 'PilotDeckGeneral'), process.platform === 'win32' ? 'junction' : 'dir');

        expect(await ensureGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: workspacesRoot,
        })).toBe(path.join(workspacesRoot, 'PilotDeckGeneral2'));
        expect(await fs.readdir(linkTarget)).toEqual([]);
    });

    it('keeps an existing populated default on first install when the application is elsewhere', async () => {
        const root = await makeTemporaryRoot();
        const directory = path.join(root, 'workspaces', 'PilotDeckGeneral');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'report.md'), 'existing');
        const env = { PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: path.join(root, 'workspaces') };
        expect(await ensureGeneralWorkspaceDirectory(env)).toBe(directory);
        expect(await fs.readFile(path.join(directory, 'report.md'), 'utf8')).toBe('existing');
        expect(await ensureGeneralWorkspaceDirectory(env)).toBe(directory);
    });

    it('skips an installation and occupied numbered folders, then preserves the selection across upgrades', async () => {
        const root = await makeTemporaryRoot();
        const workspaceRoot = path.join(root, 'workspaces');
        const installation = path.join(workspaceRoot, 'PilotDeckGeneral', 'resources', 'runtime');
        await fs.mkdir(installation, { recursive: true });
        await fs.mkdir(path.join(workspaceRoot, 'PilotDeckGeneral2'));
        await fs.writeFile(path.join(workspaceRoot, 'PilotDeckGeneral2', '.hidden'), 'existing');
        const env = { PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: workspaceRoot, PILOTDECK_DESKTOP_RUNTIME_ROOT: installation };
        const directory = await ensureGeneralWorkspaceDirectory(env);
        expect(directory).toBe(path.join(workspaceRoot, 'PilotDeckGeneral3'));
        await fs.writeFile(path.join(directory, 'report.md'), 'created by user');
        // A replacement installation changes the runtime contents, not profile identity.
        await fs.writeFile(path.join(installation, 'new-version.txt'), 'upgrade');
        vi.resetModules();
        const upgraded = await import('./generalWorkspace.js');
        expect(await upgraded.ensureGeneralWorkspaceDirectory({ ...env })).toBe(directory);
        expect(upgraded.resolveGeneralWorkspaceDirectory(env)).toBe(directory);
        expect(upgraded.generalWorkspaceNotice(env)).toEqual({ directory, originalDirectory: path.join(workspaceRoot, 'PilotDeckGeneral') });
        expect(await fs.readFile(path.join(directory, 'report.md'), 'utf8')).toBe('created by user');
        expect(await fs.readdir(workspaceRoot)).not.toContain('PilotDeckGeneral4');
    });

    it('skips a file occupying the default path and serializes concurrent initialization', async () => {
        const root = await makeTemporaryRoot();
        await fs.mkdir(path.join(root, 'workspaces'));
        await fs.writeFile(path.join(root, 'workspaces', 'PilotDeckGeneral'), 'unrelated file');
        const env = { PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: path.join(root, 'workspaces') };
        const results = await Promise.all(Array.from({ length: 4 }, () => ensureGeneralWorkspaceDirectory(env)));
        expect(new Set(results)).toEqual(new Set([path.join(root, 'workspaces', 'PilotDeckGeneral2')]));
        expect(await fs.readFile(path.join(root, 'workspaces', 'PilotDeckGeneral'), 'utf8')).toBe('unrelated file');
    });

    it('fails closed if a registered workspace is replaced or its identity is damaged', async () => {
        const root = await makeTemporaryRoot();
        const env = { PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: path.join(root, 'workspaces') };
        const directory = await ensureGeneralWorkspaceDirectory(env);
        await fs.writeFile(path.join(directory, '.pilotdeck-workspace'), JSON.stringify({ product: 'PilotDeck', version: 1, id: 'another-directory' }));
        await expect(ensureGeneralWorkspaceDirectory(env)).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_STATE_INVALID' });
        expect(await fs.readdir(path.dirname(directory))).not.toContain('PilotDeckGeneral2');
    });
});
