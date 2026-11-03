import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        expect(result).toBe(path.join(platform === 'win32' ? documentsDirectory : homeDirectory, 'PilotDeck'));
        expect(await fs.readFile(path.join(result, 'report.md'), 'utf8')).toBe('legacy report');
        expect(await fs.readFile(path.join(homeDirectory, 'general', 'report.md'), 'utf8')).toBe('legacy report');
    });

    it('merges a custom root with an already populated PilotDeck directory', async () => {
        const root = await makeTemporaryRoot();
        const workspacesRoot = path.join(root, 'custom');
        await fs.mkdir(path.join(workspacesRoot, 'general'), { recursive: true });
        await fs.mkdir(path.join(workspacesRoot, 'PilotDeck'));
        await fs.writeFile(path.join(workspacesRoot, 'general', 'report.md'), 'legacy');
        await fs.writeFile(path.join(workspacesRoot, 'PilotDeck', 'report.md'), 'current');
        const result = await ensureGeneralWorkspaceDirectory({ PILOT_HOME: path.join(root, 'profile'), WORKSPACES_ROOT: workspacesRoot });
        expect(result).toBe(path.join(workspacesRoot, 'PilotDeck'));
        expect(await fs.readFile(path.join(result, 'report.md'), 'utf8')).toBe('current');
        expect(await fs.readFile(path.join(result, 'report (from general).md'), 'utf8')).toBe('legacy');
    });

    it.each(['darwin', 'linux'])('defaults to ~/PilotDeck on %s', (platform) => {
        const homeDirectory = path.resolve('fixture-user');
        expect(resolveGeneralWorkspaceDirectory({ PILOT_HOME: path.join(homeDirectory, '.pilotdeck') }, {
            platform, homeDirectory,
        })).toBe(path.join(homeDirectory, 'PilotDeck'));
    });

    it.each(['unset', 'tilde', 'absolute'])('uses the Windows Documents folder with the default project root %s', (rootKind) => {
        const homeDirectory = path.resolve('fixture-user');
        const documentsDirectory = path.resolve('redirected-documents');
        const workspacesRoot = rootKind === 'absolute' ? homeDirectory : rootKind === 'tilde' ? '~' : undefined;
        expect(resolveGeneralWorkspaceDirectory({ PILOT_HOME: path.join(homeDirectory, '.pilotdeck'), WORKSPACES_ROOT: workspacesRoot }, {
            platform: 'win32', homeDirectory, documentsDirectory,
        })).toBe(path.join(documentsDirectory, 'PilotDeck'));
    });

    it('resolves the Windows known Documents folder outside the desktop host', () => {
        const documentsDirectory = path.resolve('system-documents');
        systemFolders.query.mockReturnValue(documentsDirectory + '\r\n');
        expect(resolveGeneralWorkspaceDirectory({}, { platform: 'win32' })).toBe(path.join(documentsDirectory, 'PilotDeck'));
        expect(systemFolders.query).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ windowsHide: true }));
    });

    it('falls back to ~/Documents if the Windows known-folder query is unavailable', async () => {
        vi.resetModules();
        systemFolders.query.mockImplementation(() => { throw new Error('PowerShell unavailable'); });
        const { resolveGeneralWorkspaceDirectory: resolveFresh } = await import('./generalWorkspace.js');
        const homeDirectory = path.resolve('fixture-user');
        expect(resolveFresh({}, { platform: 'win32', homeDirectory })).toBe(path.join(homeDirectory, 'Documents', 'PilotDeck'));
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

        expect(actual).toBe(path.join(workspacesRoot, 'PilotDeck'));
        expect((await fs.stat(actual)).isDirectory()).toBe(true);
    });

    it('recreates the managed directory after users remove the workspace root', async () => {
        const root = await makeTemporaryRoot();
        const env = {
            PILOT_HOME: path.join(root, 'pilot-home'),
            WORKSPACES_ROOT: path.join(root, 'workspaces'),
        };
        await fs.mkdir(env.PILOT_HOME);
        const first = await ensureGeneralWorkspaceDirectory(env);
        await fs.rm(env.WORKSPACES_ROOT, { recursive: true, force: true });

        expect(await ensureGeneralWorkspaceDirectory(env)).toBe(first);
        expect((await fs.stat(first)).isDirectory()).toBe(true);
    });

    it('rejects workspace roots that would expose PILOT_HOME', () => {
        const pilotHome = '/tmp/pilotdeck-home';
        expect(() => resolveGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: pilotHome,
        })).toThrow('separate from PILOT_HOME');
    });

    it('rejects a symbolic-link General directory', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'pilot-home');
        const workspacesRoot = path.join(root, 'workspaces');
        const linkTarget = path.join(root, 'elsewhere');
        await Promise.all([
            fs.mkdir(pilotHome),
            fs.mkdir(workspacesRoot),
            fs.mkdir(linkTarget),
        ]);
        await fs.symlink(linkTarget, path.join(workspacesRoot, 'PilotDeck'), process.platform === 'win32' ? 'junction' : 'dir');

        await expect(ensureGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: workspacesRoot,
        })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
    });
});
