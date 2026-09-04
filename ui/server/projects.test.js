import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
    describeProject: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
}));

vi.mock('./pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => gateway),
    isGatewayUnavailableError: (error) => /Gateway WebSocket/i.test(error?.message || ''),
    withPilotDeckGatewayReadRetry: vi.fn(async (operation) => operation(gateway)),
}));

vi.mock('./database/db.js', () => ({
    applyCustomSessionNames: vi.fn(),
}));

import { getProjects } from './projects.js';

const originalPilotHome = process.env.PILOT_HOME;

function deferred() {
    let resolve;
    const promise = new Promise((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

describe('getProjects', () => {
    beforeAll(() => {
        process.env.PILOT_HOME = '/tmp/pilotdeck-project-sort-test';
    });

    afterAll(() => {
        if (originalPilotHome === undefined) {
            delete process.env.PILOT_HOME;
        } else {
            process.env.PILOT_HOME = originalPilotHome;
        }
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
