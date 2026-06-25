/**
 * Project / session metadata layer (PilotDeck-only).
 *
 * Replaces the legacy four-provider scanner that used to read
 * ~/.gemini/projects/. After the PilotDeck-only migration:
 *
 *   - `getProjects()` lists projects via `gateway.listProjects()`.
 *   - `getSessions()` lists session transcripts via
 *     `gateway.listSessions()` (PilotDeck transcripts under
 *     ~/.pilotdeck/projects/<id>/chats/<sessionKey>.jsonl).
 *   - All sessions are returned in the single `sessions` array.
 *
 * Exports preserved for external callers under ui/server/:
 *
 *     getProjects, getProjectCronJobsOverview, getSessions,
 *     renameProject, deleteSession, deleteProject, addProjectManually,
 *     extractProjectDirectory, clearProjectDirectoryCache,
 *     searchConversations
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    getPilotDeckGateway,
} from './pilotdeck-bridge.js';
import { mapLegacySessionPresentation } from '../../src/web/server/legacySessionPresentation.js';
import {
    resolvePilotHome,
    createProjectId,
    createCollisionResistantProjectId,
    sanitizeSessionIdForPath,
} from './utils/pilotPaths.js';
import { mapCronRunOutcome } from '../../src/cron/protocol/types.js';
import sessionManager from './sessionManager.js';
import { applyCustomSessionNames } from './database/db.js';

// Optional taskmaster detection. Read once per project; lightweight.
async function detectTaskMaster(projectPath) {
    try {
        const taskMasterDir = path.join(projectPath, '.taskmaster');
        const stat = await fs.stat(taskMasterDir);
        if (!stat.isDirectory()) {
            return { hasTaskmaster: false };
        }
        let tasksJson = false;
        try {
            await fs.access(path.join(taskMasterDir, 'tasks/tasks.json'));
            tasksJson = true;
        } catch {
            tasksJson = false;
        }
        return { hasTaskmaster: true, hasTasksJson: tasksJson };
    } catch {
        return { hasTaskmaster: false };
    }
}

const directoryCache = new Map();

function rememberProjectDirectory(name, fullPath) {
    if (!name || !fullPath) return;
    directoryCache.set(name, fullPath);
}

function clearProjectDirectoryCache() {
    directoryCache.clear();
}

function projectDisplayName(fullPath) {
    return path.basename(fullPath) || fullPath;
}

/**
 * Map a PilotDeck `WebSessionInfo` onto the legacy `ProjectSession`
 * shape the React frontend expects.
 */
function toLegacySession(session, projectName) {
    const presentation = mapLegacySessionPresentation(session);
    return {
        id: session.sessionId,
        title: presentation.title,
        summary: presentation.summary,
        name: presentation.name,
        createdAt: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : new Date(session.lastModified || Date.now()).toISOString(),
        created_at: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : new Date(session.lastModified || Date.now()).toISOString(),
        updated_at: session.lastModified
            ? new Date(session.lastModified).toISOString()
            : null,
        lastActivity: session.lastModified
            ? new Date(session.lastModified).toISOString()
            : null,
        messageCount: 0,
        cwd: session.cwd,
        customTitle: session.customTitle,
        aiTitle: session.aiTitle,
        firstPrompt: session.firstPrompt,
        tag: presentation.tag,
        __projectName: projectName,
    };
}

async function readMarkedProjectPaths() {
    // Scan ~/.pilotdeck/projects/<id>/.cwd to recover real workspace paths
    // for projects whose encoded id is ambiguous (see addProjectManually).
    // Returns a Map<id, absoluteCwd>; missing/unreadable markers are skipped.
    const pilotHome = resolvePilotHome(process.env);
    const projectsDir = path.join(pilotHome, 'projects');
    const result = new Map();
    let entries = [];
    try {
        entries = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
        return result;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const cwdFile = path.join(projectsDir, entry.name, '.cwd');
        try {
            const raw = await fs.readFile(cwdFile, 'utf8');
            const cwd = raw.trim();
            if (cwd) result.set(entry.name, cwd);
        } catch {
            // No marker — listProjects can still surface this project via
            // its heuristic decoder when the path is unambiguous.
        }
    }
    return result;
}

async function getProjects(progressCallback = null) {
    const gateway = await getPilotDeckGateway();
    const { projects: webProjects } = await gateway.listProjects();
    const markedProjects = await readMarkedProjectPaths();
    const markedProjectIdsByPath = new Map(
        [...markedProjects.entries()].map(([id, cwd]) => [path.resolve(cwd), id]),
    );

    // Dedupe by `createProjectId(fullPath)` rather than raw path string.
    // The gateway's heuristic decoder for project ids (which collapses
    // `-` back into `/`) may produce a path that differs from the
    // verbatim path stored in `.cwd`, yet both encode to the same id —
    // and the SidebarV2 keys rows by that id. A raw-path Set would let
    // both rows through and produce a visible duplicate that share an
    // expand-state.
    //
    // Strategy: build a Map<projectId, entry> from the gateway list,
    // then for each `.cwd` marker either backfill a missing project or
    // override the existing entry's path with the marker (the marker is
    // the user-typed verbatim path, so it wins over the heuristic
    // decode). Session counts from the gateway are preserved.
    const byId = new Map();
    for (const project of webProjects) {
        const fullPath = project.fullPath || project.projectKey;
        if (!fullPath) continue;
        const id = markedProjectIdsByPath.get(path.resolve(fullPath)) || createProjectId(fullPath);
        if (!byId.has(id)) {
            byId.set(id, { ...project, __projectId: id });
        }
    }
    for (const [id, markedCwd] of markedProjects) {
        const existing = byId.get(id);
        if (existing) {
            existing.fullPath = markedCwd;
            existing.projectKey = markedCwd;
            existing.__projectId = id;
        } else {
            byId.set(id, {
                __projectId: id,
                fullPath: markedCwd,
                projectKey: markedCwd,
                sessionCount: 0,
            });
        }
    }
    const dedupedProjects = [...byId.values()];
    const total = dedupedProjects.length;

    const result = [];
    for (let index = 0; index < dedupedProjects.length; index += 1) {
        const project = dedupedProjects[index];
        const fullPath = project.fullPath || project.projectKey;
        const name = project.__projectId || createProjectId(fullPath);
        rememberProjectDirectory(name, fullPath);

        if (progressCallback) {
            progressCallback({
                phase: 'loading',
                processed: index,
                total,
                current: name,
            });
        }

        const sessionsResult = await gateway
            .listSessions({ projectKey: fullPath, limit: 5 })
            .catch(() => ({ sessions: [] }));
        const sessions = (sessionsResult.sessions || []).map((session) =>
            toLegacySession(session, name),
        );
        applyCustomSessionNames(sessions, 'claude');

        const taskmaster = await detectTaskMaster(fullPath).catch(() => ({
            hasTaskmaster: false,
        }));

        result.push({
            name,
            displayName: projectDisplayName(fullPath),
            fullPath,
            path: fullPath,
            lastActivity: project.lastActivity,
            sessions,
            sessionMeta: {
                total: project.sessionCount ?? sessions.length,
                hasMore: (project.sessionCount ?? sessions.length) > sessions.length,
            },
            taskmaster,
        });
    }

    if (progressCallback) {
        progressCallback({ phase: 'done', processed: total, total });
    }

    // Virtual "general" workspace — a non-project chat space rooted at
    // ~/.pilotdeck. SidebarV2 looks for a project whose `name` or
    // `displayName` equals 'general' to populate the dedicated "General"
    // toggle section. PilotDeck's gateway.listProjects() only returns
    // real project directories, so we synthesize one here. New chats
    // started from the General section use this cwd; sessions are
    // sourced from the same backend as any other project.
    const generalHome = resolvePilotHome(process.env);
    let generalSessions = [];
    let generalTotal = 0;
    let generalLastActivity;
    try {
        const generalGateway = await getPilotDeckGateway();
        // Pair the first page query with describeProject so the General
        // workspace gets the real session count instead of the page size.
        // Without this, sessionMeta.hasMore was hardcoded `false` and the
        // sidebar would silently truncate to the first 5 sessions even
        // when dozens existed under ~/.pilotdeck/projects/<encoded>/chats/.
        const [generalSessionsResult, generalSummary] = await Promise.all([
            generalGateway
                .listSessions({ projectKey: generalHome, limit: 5 })
                .catch(() => ({ sessions: [] })),
            generalGateway
                .describeProject({ projectKey: generalHome })
                .catch(() => null),
        ]);
        generalSessions = (generalSessionsResult.sessions || []).map((session) =>
            toLegacySession(session, 'general'),
        );
        applyCustomSessionNames(generalSessions, 'claude');
        generalTotal = typeof generalSummary?.sessionCount === 'number'
            ? generalSummary.sessionCount
            : generalSessions.length;
        generalLastActivity = generalSummary?.lastActivity;
    } catch {
        generalSessions = [];
        generalTotal = 0;
        generalLastActivity = undefined;
    }
    rememberProjectDirectory('general', generalHome);
    result.unshift({
        name: 'general',
        displayName: 'general',
        fullPath: generalHome,
        path: generalHome,
        lastActivity: generalLastActivity,
        sessions: generalSessions,
        sessionMeta: {
            total: generalTotal,
            hasMore: generalTotal > generalSessions.length,
        },
        taskmaster: { hasTaskmaster: false },
    });

    return result;
}

async function getSessions(projectName, limit = 5, offset = 0) {
    const gateway = await getPilotDeckGateway();
    const projectPath = await extractProjectDirectory(projectName);
    const cursor = offset > 0 ? String(offset) : undefined;
    // Fan-out the page query and the project summary (for the authoritative
    // total session count) in parallel. Without summary.sessionCount we'd
    // have to estimate `total` as `offset + page.length + hasMoreBump`,
    // which the UI then uses to compute `remaining = total - allLoaded`.
    // That estimate drifts every page and ends up showing a stale
    // "Show more (N)" that never reaches the real count — which presents
    // to the user as a button that "doesn't react" once they've already
    // pulled in everything that exists.
    const [listResult, summary] = await Promise.all([
        gateway
            .listSessions({ projectKey: projectPath, limit, cursor })
            .catch(() => ({ sessions: [] })),
        gateway
            .describeProject({ projectKey: projectPath })
            .catch(() => null),
    ]);
    const sessions = (listResult.sessions || []).map((session) =>
        toLegacySession(session, projectName),
    );
    const hasMore = Boolean(listResult.nextCursor);
    const fallbackTotal = offset + sessions.length + (hasMore ? 1 : 0);
    const total = typeof summary?.sessionCount === 'number'
        ? summary.sessionCount
        : fallbackTotal;
    return {
        sessions,
        total,
        hasMore,
        offset,
        limit,
    };
}

/**
 * Resolve a `projectName` (encoded form like `-Users-miwi-PilotDeck`,
 * a basename, or an already-absolute path) to the absolute project root.
 * Falls back to consulting the directory cache populated by
 * `getProjects()` so worktree-aware paths resolve correctly.
 */
async function extractProjectDirectory(projectName) {
    if (!projectName) {
        return resolvePilotHome(process.env);
    }
    if (path.isAbsolute(projectName)) {
        rememberProjectDirectory(projectName, projectName);
        return projectName;
    }
    const cached = directoryCache.get(projectName);
    if (cached) {
        return cached;
    }
    const markedProjects = await readMarkedProjectPaths();
    const marked = markedProjects.get(projectName);
    if (marked) {
        rememberProjectDirectory(projectName, marked);
        return marked;
    }
    if (projectName.startsWith('-')) {
        // Legacy dash-encoding heuristic: `-Users-foo-foo` → `/Users/foo/foo`.
        const decoded = '/' + projectName.replace(/^-+/, '').replace(/-/g, '/');
        rememberProjectDirectory(projectName, decoded);
        return decoded;
    }
    return resolvePilotHome(process.env);
}

async function addProjectManually(projectPath, _displayName = null) {
    if (!projectPath) {
        throw new Error('projectPath is required');
    }
    const absolute = path.resolve(projectPath);
    const pilotHome = resolvePilotHome(process.env);
    const name = await allocateProjectIdForPath(absolute, pilotHome);
    rememberProjectDirectory(name, absolute);

    // Materialize a PilotDeck project directory and drop a `.cwd` marker
    // recording the real absolute path. We need the marker because
    // createProjectId() encodes both '/' and literal '-' to '-', so the
    // PilotDeck's listWebProjects() heuristically tries each `-` as a
    // path separator and drops the project when no decode matches an
    // existing directory — which would silently lose workspaces whose
    // real path contains a dash. getProjects() reads `.cwd` to backfill
    // any project listProjects() couldn't recover.
    const projectDir = path.join(pilotHome, 'projects', name);
    try {
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(path.join(projectDir, '.cwd'), absolute, 'utf8');
    } catch (error) {
        console.warn(
            `[projects] failed to materialize PilotDeck project dir for ${name}:`,
            error?.message || error,
        );
    }

    return {
        name,
        displayName: projectDisplayName(absolute),
        fullPath: absolute,
        path: absolute,
    };
}

async function allocateProjectIdForPath(absolutePath, pilotHome) {
    const legacyId = createProjectId(absolutePath);
    const legacyDir = path.join(pilotHome, 'projects', legacyId);
    try {
        await fs.access(legacyDir);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return legacyId;
        }
        throw error;
    }

    const markerPath = path.join(legacyDir, '.cwd');
    try {
        const marker = (await fs.readFile(markerPath, 'utf8')).trim();
        if (marker && path.resolve(marker) === absolutePath) {
            return legacyId;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    return createCollisionResistantProjectId(absolutePath);
}

async function renameProject(_projectName, _displayName) {
    // PilotDeck does not yet expose a rename API. Display names are derived
    // from the project's basename today, so this is a no-op.
    return { success: true };
}

async function deleteSession(projectName, sessionId, _options = {}) {
    const fullPath = await extractProjectDirectory(projectName);
    const pilotHome = resolvePilotHome(process.env);
    const projectId = await resolveProjectIdForPathOrName(projectName, fullPath);
    // Try the sanitized filename first (current storage layout), then the
    // raw form (legacy files written before the sanitize fix).
    const safeId = sanitizeSessionIdForPath(sessionId);
    const filenames = safeId === sessionId ? [sessionId] : [safeId, sessionId];
    let removed = false;
    for (const name of filenames) {
        const transcript = path.join(
            pilotHome,
            'projects',
            projectId,
            'chats',
            `${name}.jsonl`,
        );
        try {
            await fs.unlink(transcript);
            removed = true;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return removed;
}

async function deleteProject(projectName, force = false) {
    const fullPath = await extractProjectDirectory(projectName);
    const pilotHome = resolvePilotHome(process.env);
    const projectId = await resolveProjectIdForPathOrName(projectName, fullPath);
    const projectDir = path.join(pilotHome, 'projects', projectId);
    try {
        await fs.rm(projectDir, { recursive: true, force });
        directoryCache.delete(projectName);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function resolveProjectIdForPathOrName(projectName, fullPath) {
    const markedProjects = await readMarkedProjectPaths();
    if (projectName && !path.isAbsolute(projectName) && markedProjects.has(projectName)) {
        return projectName;
    }
    const resolved = path.resolve(fullPath);
    for (const [id, cwd] of markedProjects) {
        if (path.resolve(cwd) === resolved) {
            return id;
        }
    }
    return createProjectId(fullPath);
}

async function getProjectCronJobsOverview(projectName) {
    try {
        const gateway = await getPilotDeckGateway();
        const projectKey = projectName
            ? await extractProjectDirectory(projectName)
            : undefined;
        const result = await gateway.cronList({
            projectKey,
            includeHistory: true,
            limit: 50,
        });
        const runsByTaskId = new Map();
        if (Array.isArray(result.recentRuns)) {
            for (const run of result.recentRuns) {
                if (!run.taskId) continue;
                const existing = runsByTaskId.get(run.taskId);
                if (!existing || run.startedAt > existing.startedAt) {
                    runsByTaskId.set(run.taskId, run);
                }
            }
        }
        const jobs = (result.tasks || []).map((task) => {
            const latestRun = runsByTaskId.get(task.taskId) || null;
            const isCron = task.schedule?.type === 'cron';
            return {
                id: task.taskId,
                projectKey: task.projectKey || null,
                cron: isCron ? task.schedule.expression : '',
                prompt: task.message || '',
                createdAt: task.createdAt,
                recurring: isCron,
                permanent: isCron,
                manualOnly: false,
                status: task.status === 'running' ? 'running' : 'scheduled',
                lastFiredAt: latestRun?.startedAt ? new Date(latestRun.startedAt).getTime() : undefined,
                latestRun: latestRun ? {
                    status: mapCronRunOutcome(latestRun.outcome, latestRun.finishedAt),
                    runId: latestRun.runId,
                    startedAt: latestRun.startedAt,
                    taskId: latestRun.taskId,
                    sessionId: latestRun.sessionKey,
                } : null,
            };
        });
        return { jobs };
    } catch (error) {
        console.warn('[projects] cronList via gateway failed, returning empty:', error?.message);
        return { jobs: [] };
    }
}

async function searchConversations(query, limit = 50, onProjectResult = null, signal = null) {
    const needle = (query || '').trim().toLowerCase();
    if (!needle) {
        return { totalMatches: 0 };
    }
    const projects = await getProjects();
    let totalMatches = 0;
    for (let index = 0; index < projects.length; index += 1) {
        if (signal?.aborted) break;
        const project = projects[index];
        const matches = (project.sessions || []).filter((session) => {
            const haystack = [
                session.title,
                session.summary,
                session.customTitle,
                session.aiTitle,
                session.firstPrompt,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(needle);
        });
        if (matches.length > 0) {
            const projectResult = {
                project: { name: project.name, fullPath: project.fullPath },
                matches,
            };
            totalMatches += matches.length;
            if (onProjectResult) {
                await Promise.resolve(
                    onProjectResult({
                        projectResult,
                        totalMatches,
                        scannedProjects: index + 1,
                        totalProjects: projects.length,
                    }),
                ).catch(() => undefined);
            }
            if (totalMatches >= limit) break;
        }
    }
    return { totalMatches };
}

export {
    getProjects,
    getProjectCronJobsOverview,
    getSessions,
    renameProject,
    deleteSession,
    deleteProject,
    addProjectManually,
    extractProjectDirectory,
    clearProjectDirectoryCache,
    searchConversations,
};
