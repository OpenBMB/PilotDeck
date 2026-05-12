/**
 * Project / session metadata layer (PilotDeck-only).
 *
 * Replaces the legacy four-provider scanner that used to read
 * ~/.claude/projects/, ~/.cursor/chats/, ~/.codex/sessions/,
 * ~/.gemini/projects/. After the PilotDeck-only migration:
 *
 *   - `getProjects()` lists projects via `gateway.listProjects()`.
 *   - `getSessions()` lists session transcripts via
 *     `gateway.listSessions()` (PilotDeck transcripts under
 *     ~/.pilotdeck/projects/<id>/chats/<sessionKey>.jsonl).
 *   - The legacy `cursorSessions / codexSessions / geminiSessions`
 *     arrays remain in the response shape (empty) for back-compat with
 *     the existing React components — those components already render
 *     fine when the arrays are empty.
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
    getPilotDeckRepoRoot,
} from './pilotdeck-bridge.js';
import { resolvePilotHome, createProjectId } from './utils/pilotPaths.js';
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
 * shape the React frontend expects. We tag every session as
 * `__provider: 'claude'` so the existing chat composer falls through to
 * `startClaudeSessionCommand` (which dispatches `claude-command`) — the
 * PilotDeck bridge in `index.js` accepts that and routes it through
 * `src/gateway`.
 */
function toLegacySession(session, projectName) {
    return {
        id: session.sessionId,
        title: session.summary || session.firstPrompt || session.sessionId,
        summary: session.summary || session.firstPrompt || session.sessionId,
        name: session.summary || session.firstPrompt || session.sessionId,
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
        tag: session.tag,
        __provider: 'claude',
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
    const seenByPath = new Set(
        webProjects.map((p) => p.fullPath || p.projectKey).filter(Boolean),
    );
    // Backfill any project whose `.cwd` marker exists but listProjects()
    // failed to surface (typically because the path contains '-').
    for (const [, markedCwd] of markedProjects) {
        if (seenByPath.has(markedCwd)) continue;
        webProjects.push({ fullPath: markedCwd, projectKey: markedCwd, sessionCount: 0 });
        seenByPath.add(markedCwd);
    }
    const total = webProjects.length;

    const result = [];
    for (let index = 0; index < webProjects.length; index += 1) {
        const project = webProjects[index];
        const fullPath = project.fullPath || project.projectKey;
        const name = createProjectId(fullPath);
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
            sessions,
            cursorSessions: [],
            codexSessions: [],
            geminiSessions: [],
            sessionMeta: {
                total: project.sessionCount ?? sessions.length,
                hasMore: (project.sessionCount ?? sessions.length) > sessions.length,
            },
            taskmaster,
            alwaysOn: { enabled: false },
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
    try {
        const generalGateway = await getPilotDeckGateway();
        const generalSessionsResult = await generalGateway
            .listSessions({ projectKey: generalHome, limit: 5 })
            .catch(() => ({ sessions: [] }));
        generalSessions = (generalSessionsResult.sessions || []).map((session) =>
            toLegacySession(session, 'general'),
        );
        applyCustomSessionNames(generalSessions, 'claude');
    } catch {
        generalSessions = [];
    }
    rememberProjectDirectory('general', generalHome);
    result.unshift({
        name: 'general',
        displayName: 'general',
        fullPath: generalHome,
        path: generalHome,
        sessions: generalSessions,
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        sessionMeta: {
            total: generalSessions.length,
            hasMore: false,
        },
        taskmaster: { hasTaskmaster: false },
        alwaysOn: { enabled: false },
    });

    return result;
}

async function getSessions(projectName, limit = 5, offset = 0) {
    const gateway = await getPilotDeckGateway();
    const projectPath = await extractProjectDirectory(projectName);
    const cursor = offset > 0 ? String(offset) : undefined;
    const result = await gateway
        .listSessions({ projectKey: projectPath, limit, cursor })
        .catch(() => ({ sessions: [] }));
    const sessions = (result.sessions || []).map((session) =>
        toLegacySession(session, projectName),
    );
    return {
        sessions,
        total: offset + sessions.length + (result.nextCursor ? 1 : 0),
        hasMore: Boolean(result.nextCursor),
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
        return getPilotDeckRepoRoot();
    }
    if (path.isAbsolute(projectName)) {
        rememberProjectDirectory(projectName, projectName);
        return projectName;
    }
    const cached = directoryCache.get(projectName);
    if (cached) {
        return cached;
    }
    if (projectName.startsWith('-')) {
        // Legacy dash-encoding heuristic: `-Users-miwi-foo` → `/Users/miwi/foo`.
        const decoded = '/' + projectName.replace(/^-+/, '').replace(/-/g, '/');
        rememberProjectDirectory(projectName, decoded);
        return decoded;
    }
    return getPilotDeckRepoRoot();
}

async function addProjectManually(projectPath, _displayName = null) {
    if (!projectPath) {
        throw new Error('projectPath is required');
    }
    const absolute = path.resolve(projectPath);
    const name = createProjectId(absolute);
    rememberProjectDirectory(name, absolute);

    // Materialize a PilotDeck project directory and drop a `.cwd` marker
    // recording the real absolute path. We need the marker because
    // createProjectId() encodes both '/' and literal '-' to '-', so the
    // encoded id alone is ambiguous (e.g. /Users/me/claude-code and
    // /Users/me/claude/code share the id "Users-me-claude-code").
    // PilotDeck's listWebProjects() heuristically tries each `-` as a
    // path separator and drops the project when no decode matches an
    // existing directory — which would silently lose workspaces whose
    // real path contains a dash. getProjects() reads `.cwd` to backfill
    // any project listProjects() couldn't recover.
    const pilotHome = resolvePilotHome(process.env);
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

async function renameProject(_projectName, _displayName) {
    // PilotDeck does not yet expose a rename API. Display names are derived
    // from the project's basename today, so this is a no-op.
    return { success: true };
}

async function deleteSession(projectName, sessionId, _options = {}) {
    const fullPath = await extractProjectDirectory(projectName);
    const pilotHome = resolvePilotHome(process.env);
    const projectId = createProjectId(fullPath);
    const transcript = path.join(
        pilotHome,
        'projects',
        projectId,
        'chats',
        `${sessionId}.jsonl`,
    );
    try {
        await fs.unlink(transcript);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function deleteProject(projectName, force = false) {
    const fullPath = await extractProjectDirectory(projectName);
    const pilotHome = resolvePilotHome(process.env);
    const projectId = createProjectId(fullPath);
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

async function getProjectCronJobsOverview(_projectName) {
    // Cron run-now / per-project history landed-on-disk surfaces are
    // deferred under the PilotDeck-only migration. The Cron tab in the
    // frontend already renders gracefully with an empty list.
    return { jobs: [] };
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
