import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPathInsideOrEqual } from './pathSafety.js';
import { resolvePilotHome } from './pilotPaths.js';

export const GENERAL_WORKSPACE_DIRECTORY_NAME = 'general';

function expandHome(input) {
    if (input === '~') return os.homedir();
    if (input.startsWith('~/')) return path.resolve(os.homedir(), input.slice(2));
    return path.resolve(input);
}
function assertSeparatedFromPilotHome(candidate, pilotHome) {
    if (
        isPathInsideOrEqual(pilotHome, candidate)
        || isPathInsideOrEqual(candidate, pilotHome)
    ) {
        const error = new Error('General workspace must be separate from PILOT_HOME.');
        error.code = 'GENERAL_WORKSPACE_UNSAFE';
        throw error;
    }
}

export function resolveGeneralWorkspaceDirectory(env = process.env) {
    const workspacesRoot = expandHome(env.WORKSPACES_ROOT || os.homedir());
    const candidate = path.resolve(workspacesRoot, GENERAL_WORKSPACE_DIRECTORY_NAME);
    assertSeparatedFromPilotHome(candidate, resolvePilotHome(env));
    return candidate;
}

/**
 * Materialize the managed working directory used by General conversations.
 *
 * General transcripts deliberately remain keyed by PILOT_HOME for backwards
 * compatibility. Only the agent's execution cwd moves here, keeping config,
 * credentials, and transcript storage outside the workspace it may operate on.
 */
export async function ensureGeneralWorkspaceDirectory(env = process.env) {
    const candidate = resolveGeneralWorkspaceDirectory(env);
    const pilotHome = resolvePilotHome(env);

    const existing = await fs.lstat(candidate).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (existing?.isSymbolicLink()) {
        const error = new Error('General workspace cannot be a symbolic link.');
        error.code = 'GENERAL_WORKSPACE_UNSAFE';
        throw error;
    }
    if (existing && !existing.isDirectory()) {
        const error = new Error('General workspace path is not a directory.');
        error.code = 'GENERAL_WORKSPACE_UNSAFE';
        throw error;
    }

    await fs.mkdir(candidate, { recursive: true, mode: 0o700 });

    const created = await fs.lstat(candidate);
    if (created.isSymbolicLink() || !created.isDirectory()) {
        const error = new Error('General workspace path is not a safe directory.');
        error.code = 'GENERAL_WORKSPACE_UNSAFE';
        throw error;
    }

    const [realCandidate, realPilotHome] = await Promise.all([
        fs.realpath(candidate),
        fs.realpath(pilotHome).catch((error) => {
            if (error?.code === 'ENOENT') return path.resolve(pilotHome);
            throw error;
        }),
    ]);
    assertSeparatedFromPilotHome(realCandidate, realPilotHome);
    await fs.chmod(candidate, 0o700).catch(() => {});
    return candidate;
}
