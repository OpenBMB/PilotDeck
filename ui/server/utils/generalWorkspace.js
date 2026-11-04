import { constants, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { isPathInsideOrEqual } from './pathSafety.js';
import { createProjectId, resolvePilotHome } from './pilotPaths.js';
import { migrateLegacyGeneralWorkspace } from './generalWorkspaceMigration.js';

export const GENERAL_WORKSPACE_DIRECTORY_NAME = 'PilotDeckGeneral';
export const GENERAL_WORKSPACE_MARKER = '.pilotdeck-workspace';

let windowsDocumentsDirectory;
function resolveWindowsDocumentsDirectory(homeDirectory) {
    if (windowsDocumentsDirectory === undefined) {
        try {
            // The known folder may be redirected (for example to OneDrive).
            windowsDocumentsDirectory = execFileSync('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Environment]::GetFolderPath('MyDocuments')",
            ], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch { windowsDocumentsDirectory = ''; }
    }
    return windowsDocumentsDirectory || path.join(homeDirectory, 'Documents');
}

function expandHome(input, homeDirectory) {
    if (input === '~') return homeDirectory;
    if (/^~[\\/]/.test(input)) return path.resolve(homeDirectory, input.slice(2));
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

function defaultWorkspaceDirectory(env = process.env, {
    platform = process.platform,
    homeDirectory = os.homedir(),
    documentsDirectory = env.PILOTDECK_DOCUMENTS_DIRECTORY,
} = {}) {
    const configuredRoot = env.WORKSPACES_ROOT ? expandHome(env.WORKSPACES_ROOT, homeDirectory) : null;
    // WORKSPACES_ROOT historically defaults to the user's home for project
    // browsing. Only a custom root overrides the managed General location.
    const workspacesRoot = configuredRoot && path.relative(homeDirectory, configuredRoot) !== ''
        ? configuredRoot
        : platform === 'win32'
            ? documentsDirectory || resolveWindowsDocumentsDirectory(homeDirectory)
            : homeDirectory;
    return path.resolve(workspacesRoot, GENERAL_WORKSPACE_DIRECTORY_NAME);
}

function locationStatePath(env) {
    return path.join(resolvePilotHome(env), 'general-workspace.json');
}
function readDefaultLocation(env, baseDirectory) {
    let state;
    try { state = JSON.parse(readFileSync(locationStatePath(env), 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw Object.assign(new Error('Cannot read the saved General workspace location.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
    }
    if (state.version !== 1 || typeof state.directory !== 'string' || typeof state.baseDirectory !== 'string' || typeof state.workspaceId !== 'string') {
        throw Object.assign(new Error('Invalid saved General workspace location.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
    }
    const sameParent = path.relative(path.dirname(baseDirectory), path.dirname(state.baseDirectory)) === '';
    if (path.relative(baseDirectory, state.baseDirectory) !== '' && !(sameParent && path.basename(state.baseDirectory) === 'PilotDeck')) return null;
    const name = path.basename(state.directory);
    if (path.relative(path.dirname(baseDirectory), path.dirname(state.directory)) !== ''
        || !/^PilotDeck(?:General)?(?:[2-9]|[1-9]\d+)?$/.test(name)) {
        throw Object.assign(new Error('Invalid saved General workspace directory.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
    }
    return state;
}

export function resolveGeneralWorkspaceDirectory(env = process.env, options = {}) {
    const configuredDirectory = env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY?.trim();
    let candidate;
    if (configuredDirectory) {
        if (!path.isAbsolute(configuredDirectory) && !/^~(?:[\\/]|$)/.test(configuredDirectory)) {
            throw Object.assign(new Error('General workspace must be an absolute path or start with ~.'), { code: 'GENERAL_WORKSPACE_INVALID' });
        }
        candidate = expandHome(configuredDirectory, options.homeDirectory ?? os.homedir());
    } else {
        const base = defaultWorkspaceDirectory(env, options);
        candidate = readDefaultLocation(env, base)?.directory ?? base;
    }
    assertSeparatedFromPilotHome(candidate, resolvePilotHome(env));
    return candidate;
}

export function generalWorkspaceNotice(env = process.env, options = {}) {
    if (env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY?.trim()) return null;
    const state = readDefaultLocation(env, defaultWorkspaceDirectory(env, options));
    return state?.reason ? { directory: state.directory, originalDirectory: state.baseDirectory } : null;
}

// Resolve even a missing leaf through its closest existing ancestor before
// creating anything, so a linked parent cannot redirect writes into PILOT_HOME.
async function realPlannedPath(candidate) {
    try { return await fs.realpath(candidate); }
    catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        return path.join(await realPlannedPath(parent), path.basename(candidate));
    }
}

async function assertSafeLocation(candidate, env) {
    const pilotHome = resolvePilotHome(env);
    const [plannedCandidate, plannedPilotHome] = await Promise.all([
        realPlannedPath(candidate), realPlannedPath(pilotHome),
    ]);
    assertSeparatedFromPilotHome(plannedCandidate, plannedPilotHome);
    const runtimeRoots = [env.PILOTDECK_DESKTOP_RUNTIME_ROOT, env.PILOTDECK_RUNTIME_ROOT].filter(Boolean);
    const installationPaths = [env.PILOTDECK_DESKTOP_INSTALL_ROOT,
        fileURLToPath(new URL('../../../', import.meta.url)), ...runtimeRoots];
    // Older desktop launchers supplied only resources/runtime. Protect its
    // complete install too: upgrades replace the enclosing resources tree.
    for (const runtime of runtimeRoots) {
        const resources = path.dirname(path.resolve(runtime));
        if (path.basename(runtime).toLowerCase() === 'runtime' && path.basename(resources).toLowerCase() === 'resources') {
            const parent = path.dirname(resources);
            installationPaths.push(path.basename(parent) === 'Contents' ? path.dirname(parent) : parent);
        }
    }
    for (const installation of installationPaths.filter(Boolean)) {
        const realInstallation = await realPlannedPath(path.resolve(installation));
        if (isPathInsideOrEqual(plannedCandidate, realInstallation) || isPathInsideOrEqual(realInstallation, plannedCandidate)) {
            throw Object.assign(new Error('General workspace overlaps the PilotDeck installation.'), { code: 'GENERAL_WORKSPACE_UNSAFE' });
        }
    }
}

/**
 * Materialize the managed working directory used by General conversations.
 *
 * General transcripts deliberately remain keyed by PILOT_HOME for backwards
 * compatibility. Only the agent's execution cwd moves here, keeping config,
 * credentials, and transcript storage outside the workspace it may operate on.
 */
async function prepareDirectory(candidate, env, { requireEmpty = false, workspaceId } = {}) {
    const pilotHome = resolvePilotHome(env);
    await assertSafeLocation(candidate, env);

    const existing = await fs.lstat(candidate).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (workspaceId && !existing) throw Object.assign(new Error('The registered General workspace is unavailable.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
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
    if (requireEmpty && existing && (await fs.readdir(candidate)).length > 0) {
        throw Object.assign(new Error('The selected General workspace is not empty.'), { code: 'GENERAL_WORKSPACE_NOT_EMPTY' });
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
    await fs.access(candidate, constants.W_OK);
    const markerPath = path.join(candidate, GENERAL_WORKSPACE_MARKER);
    let marker;
    try {
        const stat = await fs.lstat(markerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid workspace marker');
        marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        if (marker.product !== 'PilotDeck' || marker.version !== 1 || typeof marker.id !== 'string') throw new Error('Invalid workspace marker');
    } catch (error) {
        if (error.code !== 'ENOENT') throw Object.assign(new Error('Cannot verify the General workspace identity.'), { code: 'GENERAL_WORKSPACE_UNSAFE' });
        if (workspaceId) throw Object.assign(new Error('The registered General workspace marker is missing.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
        marker = { product: 'PilotDeck', version: 1, id: randomUUID() };
        try { await fs.writeFile(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 }); }
        catch (writeError) {
            // Another profile/process may have claimed the same unnumbered
            // default concurrently. Revalidate its marker instead of replacing it.
            if (writeError.code === 'EEXIST') return prepareDirectory(candidate, env, { workspaceId });
            throw writeError;
        }
    }
    if (workspaceId && marker.id !== workspaceId) throw Object.assign(new Error('The registered General workspace was replaced.'), { code: 'GENERAL_WORKSPACE_STATE_INVALID' });
    return { candidate, realPilotHome, workspaceId: marker.id };
}

const locationLocks = new Map();
export async function ensureGeneralWorkspaceDirectory(env = process.env, options = {}) {
    if (env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY?.trim()) {
        const candidate = resolveGeneralWorkspaceDirectory(env, options);
        await assertSafeLocation(candidate, env);
        if (!env.PILOTDECK_GENERAL_WORKSPACE_ID) await assertGeneralWorkspaceSwitchAllowed(null, candidate);
        await prepareDirectory(candidate, env, { workspaceId: env.PILOTDECK_GENERAL_WORKSPACE_ID || undefined });
        return candidate;
    }
    const key = resolvePilotHome(env);
    const previous = locationLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => ensureDefaultDirectory(env, options));
    locationLocks.set(key, next);
    try { return await next; }
    finally { if (locationLocks.get(key) === next) locationLocks.delete(key); }
}

async function ensureDefaultDirectory(env, options) {
    const base = defaultWorkspaceDirectory(env, options);
    const state = readDefaultLocation(env, base);
    const pilotHome = resolvePilotHome(env);
    // Numbering cannot repair an unsafe parent (all siblings would be unsafe).
    if (isPathInsideOrEqual(await realPlannedPath(pilotHome), await realPlannedPath(path.dirname(base)))) {
        assertSeparatedFromPilotHome(base, pilotHome);
    }
    let candidate = state?.directory ?? base;
    let prepared;
    let reason = state?.reason;
    if (state) {
        // Upgrades reuse a registered directory, including populated ones.
        // Unavailability or identity loss must never silently choose another cwd.
        prepared = await prepareDirectory(state.directory, env, { workspaceId: state.workspaceId });
    }
    if (!state) {
        // Before location records existed, General transcripts were keyed by
        // PILOT_HOME. Adopt the old PilotDeck folder only with this upgrade
        // evidence, never merely because a same-named unrelated folder exists.
        const legacy = path.join(path.dirname(base), 'PilotDeck');
        const transcriptDirectory = path.join(pilotHome, 'projects', createProjectId(pilotHome), 'chats');
        const hasGeneralHistory = (await fs.readdir(transcriptDirectory).catch(error => {
            if (error.code === 'ENOENT') return []; throw error;
        })).some(name => name.endsWith('.jsonl'));
        if (hasGeneralHistory && await fs.lstat(legacy).then(stat => stat.isDirectory() && !stat.isSymbolicLink()).catch(error => {
            if (error.code === 'ENOENT') return false; throw error;
        })) {
            try { prepared = await prepareDirectory(legacy, env); candidate = legacy; }
            catch (error) { if (error.code !== 'GENERAL_WORKSPACE_UNSAFE') throw error; }
        }
    }
    for (let suffix = 1; !prepared && suffix <= 1000; suffix++) {
        candidate = suffix === 1 ? base : `${base}${suffix}`;
        try {
            prepared = await prepareDirectory(candidate, env, { requireEmpty: suffix > 1 && candidate !== state?.directory });
            break;
        } catch (error) {
            if (!['GENERAL_WORKSPACE_UNSAFE', 'GENERAL_WORKSPACE_NOT_EMPTY', 'EEXIST'].includes(error.code)) throw error;
            reason = 'default_conflict';
        }
    }
    if (!prepared) throw Object.assign(new Error('No safe General workspace directory is available.'), { code: 'GENERAL_WORKSPACE_UNSAFE' });
    if (!state || state.directory !== candidate) {
        const statePath = locationStatePath(env);
        await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
        const temporary = `${statePath}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify({ version: 1, baseDirectory: base, directory: candidate, workspaceId: prepared.workspaceId, reason }), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, statePath);
        } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    // The previous managed directory was <WORKSPACES_ROOT || home>/general,
    // including ~/general on Windows before the move into Documents.
    // Choosing a custom folder does not copy or relocate existing files.
    const homeDirectory = options.homeDirectory ?? os.homedir();
    const legacyDirectory = path.resolve(expandHome(env.WORKSPACES_ROOT || homeDirectory, homeDirectory), 'general');
    assertSeparatedFromPilotHome(legacyDirectory, pilotHome);
    await migrateLegacyGeneralWorkspace({ source: legacyDirectory, destination: candidate, pilotHome: prepared.realPilotHome });
    await fs.chmod(candidate, 0o700).catch(() => {});
    return candidate;
}

export async function assertGeneralWorkspaceSwitchAllowed(currentDirectory, nextDirectory) {
    if (currentDirectory && path.relative(await realPlannedPath(currentDirectory), await realPlannedPath(nextDirectory)) === '') return;
    const entries = await fs.readdir(nextDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    // The product marker is metadata; all user files, including dotfiles, count.
    if (entries.some(name => name !== GENERAL_WORKSPACE_MARKER)) throw Object.assign(new Error('The selected General workspace is not empty.'), { code: 'GENERAL_WORKSPACE_NOT_EMPTY' });
}

export async function generalWorkspaceIdentity(directory) {
    return JSON.parse(await fs.readFile(path.join(directory, GENERAL_WORKSPACE_MARKER), 'utf8')).id;
}
