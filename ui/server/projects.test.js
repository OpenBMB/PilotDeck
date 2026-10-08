import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gateway = vi.hoisted(() => ({
    closeSession: vi.fn(),
    describeProject: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
}));

vi.mock('./pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => gateway),
    beginSessionDeletion: vi.fn(() => () => {}),
    isGatewayUnavailableError: (error) => /Gateway WebSocket/i.test(error?.message || ''),
    withPilotDeckGatewayReadRetry: vi.fn(async (operation) => operation(gateway)),
}));

vi.mock('./database/db.js', () => ({
    applyCustomSessionNames: vi.fn(),
}));

import { addProjectManually, deleteSession, getProjects, getProjectsSnapshot } from './projects.js';
import { createProjectId, sanitizeSessionIdForPath } from './utils/pilotPaths.js';

const originalPilotHome = process.env.PILOT_HOME;
const originalWorkspacesRoot = process.env.WORKSPACES_ROOT;
let testWorkspacesRoot;

function deferred() {
    let resolve;
    const promise = new Promise((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

describe('getProjects', () => {
    beforeAll(async () => {
        process.env.PILOT_HOME = '/tmp/pilotdeck-project-sort-test';
        testWorkspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-projects-test-'));
        process.env.WORKSPACES_ROOT = testWorkspacesRoot;
    });

    afterAll(async () => {
        if (originalPilotHome === undefined) {
            delete process.env.PILOT_HOME;
        } else {
            process.env.PILOT_HOME = originalPilotHome;
        }
        if (originalWorkspacesRoot === undefined) {
            delete process.env.WORKSPACES_ROOT;
        } else {
            process.env.WORKSPACES_ROOT = originalWorkspacesRoot;
        }
        await fs.rm(testWorkspacesRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        gateway.describeProject.mockReset();
        gateway.listProjects.mockReset();
        gateway.listSessions.mockReset();

        gateway.listSessions.mockResolvedValue({ sessions: [] });
        gateway.describeProject.mockResolvedValue({
            sessionCount: 0,
            lastActivity: 200,
        });
    });

    it('sorts projects by the newest session interaction and puts missing activity last', async () => {
        gateway.listSessions.mockImplementation(async ({ projectKey }) => ({
            sessions: projectKey === '/workspace/alpha'
                ? [{ sessionId: 'alpha-session', lastModified: 400 }]
                : projectKey === '/workspace/zeta'
                    ? [{ sessionId: 'zeta-session', lastModified: 50 }]
                    : [],
        }));
        gateway.listProjects.mockResolvedValueOnce({
            projects: [
                {
                    projectKey: '/workspace/alpha',
                    name: 'alpha',
                    fullPath: '/workspace/alpha',
                    sessionCount: 1,
                    lastActivity: 100,
                },
                {
                    projectKey: '/workspace/dormant',
                    name: 'dormant',
                    fullPath: '/workspace/dormant',
                    sessionCount: 0,
                    createdAt: 250,
                    lastActivity: 999,
                },
                {
                    projectKey: '/workspace/zeta',
                    name: 'zeta',
                    fullPath: '/workspace/zeta',
                    sessionCount: 1,
                    lastActivity: 300,
                },
            ],
        });

        const projects = await getProjects();

        expect(projects.map((project) => project.name)).toEqual([
            'workspace-alpha',
            'workspace-dormant',
            'workspace-zeta',
            'general',
        ]);
        expect(projects.find((project) => project.name === 'general')).toMatchObject({
            kind: 'general',
            fullPath: process.env.PILOT_HOME,
            workspaceCwd: path.join(testWorkspacesRoot, 'general'),
            capabilities: {
                files: false,
                explore: false,
                projectFileMentions: false,
            },
        });
        expect(projects.find((project) => project.name === 'workspace-alpha')?.lastActivity).toBe(400);
        expect(projects.find((project) => project.name === 'workspace-dormant')?.lastActivity).toBe(250);
    });

    it('keeps the project summary activity when the session preview fails', async () => {
        gateway.listProjects.mockResolvedValue({
            projects: [{
                projectKey: '/workspace/active',
                name: 'active',
                fullPath: '/workspace/active',
                sessionCount: 2,
                lastActivity: 400,
                createdAt: 100,
            }],
        });
        gateway.listSessions.mockRejectedValue(new Error('gateway unavailable'));

        const projects = await getProjects();

        expect(projects.find((project) => project.name === 'workspace-active')?.lastActivity).toBe(400);
    });

    it('does not turn a Gateway transport failure into an empty project list', async () => {
        gateway.listProjects.mockRejectedValue(new Error('Gateway WebSocket closed.'));

        await expect(getProjects()).rejects.toThrow('Gateway WebSocket closed.');
    });

    it('starts General session preview and summary requests concurrently', async () => {
        const sessions = deferred();
        const summary = deferred();
        gateway.listProjects.mockResolvedValue({ projects: [] });
        gateway.listSessions.mockImplementation(({ projectKey }) => {
            if (projectKey === process.env.PILOT_HOME) return sessions.promise;
            return Promise.resolve({ sessions: [] });
        });
        gateway.describeProject.mockImplementation(({ projectKey }) => {
            if (projectKey === process.env.PILOT_HOME) return summary.promise;
            return Promise.resolve({ sessionCount: 0 });
        });

        const projectsPromise = getProjects();
        try {
            await vi.waitFor(() => expect(gateway.listSessions).toHaveBeenCalledWith({
                projectKey: process.env.PILOT_HOME,
                limit: 5,
            }));
            expect(gateway.describeProject).toHaveBeenCalledWith({
                projectKey: process.env.PILOT_HOME,
            });
        } finally {
            sessions.resolve({ sessions: [] });
            summary.resolve({ sessionCount: 0, createdAt: 100 });
            await projectsPromise;
        }
    });
});


describe('project registration and snapshot ordering', () => {
    let pilotHome;
    let previousHome;
    let previousWorkspacesRoot;
    beforeEach(async () => {
        previousHome = process.env.PILOT_HOME;
        previousWorkspacesRoot = process.env.WORKSPACES_ROOT;
        pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-project-registration-'));
        process.env.PILOT_HOME = pilotHome;
        process.env.WORKSPACES_ROOT = path.join(pilotHome, 'workspaces');
        gateway.listProjects.mockReset().mockResolvedValue({ projects: [] });
        gateway.listSessions.mockReset().mockResolvedValue({ sessions: [] });
        gateway.describeProject.mockReset().mockResolvedValue({ sessionCount: 0 });
    });
    afterEach(async () => {
        if (previousHome === undefined) delete process.env.PILOT_HOME;
        else process.env.PILOT_HOME = previousHome;
        if (previousWorkspacesRoot === undefined) delete process.env.WORKSPACES_ROOT;
        else process.env.WORKSPACES_ROOT = previousWorkspacesRoot;
        vi.restoreAllMocks();
        await fs.rm(pilotHome, { recursive: true, force: true });
    });

    it('registers without querying any project or session history', async () => {
        const workspace = path.join(pilotHome, 'workspace');
        const registered = await addProjectManually(workspace);
        expect(registered).toMatchObject({
            fullPath: workspace, lastActivity: expect.any(Number), projectListRevision: expect.any(Number),
        });
        expect(await fs.readFile(path.join(pilotHome, 'projects', registered.name, '.cwd'), 'utf8')).toBe(workspace);
        expect(gateway.listProjects).not.toHaveBeenCalled();
        expect(gateway.listSessions).not.toHaveBeenCalled();
    });

    it('orders a slow scan before a registration even when it finishes afterwards', async () => {
        const pending = deferred();
        gateway.listProjects.mockReturnValueOnce(pending.promise);
        const oldSnapshot = getProjectsSnapshot();
        const registered = await addProjectManually(path.join(pilotHome, 'workspace'));
        pending.resolve({ projects: [] });
        expect((await oldSnapshot).revision).toBeLessThan(registered.projectListRevision);
        expect((await getProjectsSnapshot()).revision).toBeGreaterThan(registered.projectListRevision);
    });

    it('rejects a failed registration instead of returning a project the UI would display', async () => {
        const error = new Error('Disk write failed');
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(error);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(addProjectManually(path.join(pilotHome, 'workspace'))).rejects.toBe(error);
    });
});

describe('deleteSession lifecycle', () => {
    let pilotHome;
    let previousHome;
    let project;
    let transcript;
    const sessionId = 'web:delete-background-title';
    beforeEach(async () => {
        previousHome = process.env.PILOT_HOME;
        pilotHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-delete-lifecycle-'));
        process.env.PILOT_HOME = pilotHome;
        project = path.join(pilotHome, 'workspace');
        const projectDirectory = path.join(pilotHome, 'projects', createProjectId(project));
        await fs.mkdir(path.join(projectDirectory, 'chats'), {recursive: true});
        await fs.writeFile(path.join(projectDirectory, '.cwd'), project);
        transcript = path.join(projectDirectory, 'chats', sanitizeSessionIdForPath(sessionId) + '.jsonl');
        await fs.writeFile(transcript, 'original transcript');
        gateway.closeSession.mockReset();
    });
    afterEach(async () => {
        if (previousHome === undefined) delete process.env.PILOT_HOME;
        else process.env.PILOT_HOME = previousHome;
        await fs.rm(pilotHome, {recursive: true, force: true});
    });
    it('waits for the gateway writer to close before unlinking its transcript', async () => {
        const closing = deferred();
        gateway.closeSession.mockReturnValue(closing.promise);
        const deletion = deleteSession(project, sessionId);
        await vi.waitFor(() => expect(gateway.closeSession).toHaveBeenCalledWith({sessionKey: sessionId, reason: 'session_deleted'}));
        expect(await fs.readFile(transcript, 'utf8')).toBe('original transcript');
        closing.resolve();
        expect(await deletion).toBe(true);
        await expect(fs.readFile(transcript)).rejects.toMatchObject({code: 'ENOENT'});
    });
    it('leaves the transcript intact when the runtime cannot be closed', async () => {
        gateway.closeSession.mockRejectedValue(new Error('Gateway unavailable'));
        await expect(deleteSession(project, sessionId)).rejects.toThrow('Gateway unavailable');
        expect(await fs.readFile(transcript, 'utf8')).toBe('original transcript');
    });
});
