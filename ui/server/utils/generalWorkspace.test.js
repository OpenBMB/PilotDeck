import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ensureGeneralWorkspaceDirectory,
    resolveGeneralWorkspaceDirectory,
} from './generalWorkspace.js';

const temporaryRoots = [];

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
    it('creates a managed General directory under WORKSPACES_ROOT', async () => {
        const root = await makeTemporaryRoot();
        const pilotHome = path.join(root, 'pilot-home');
        const workspacesRoot = path.join(root, 'workspaces');
        await fs.mkdir(pilotHome);

        const actual = await ensureGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: workspacesRoot,
        });

        expect(actual).toBe(path.join(workspacesRoot, 'general'));
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
        await fs.symlink(linkTarget, path.join(workspacesRoot, 'general'));

        await expect(ensureGeneralWorkspaceDirectory({
            PILOT_HOME: pilotHome,
            WORKSPACES_ROOT: workspacesRoot,
        })).rejects.toMatchObject({ code: 'GENERAL_WORKSPACE_UNSAFE' });
    });
});
