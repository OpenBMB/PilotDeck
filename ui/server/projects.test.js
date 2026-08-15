import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectId, getPilotProjectChatDir } from '../../src/pilot/index.js';

const tempDirs = [];
const originalPilotHome = process.env.PILOT_HOME;
const originalGatewayTimeout = process.env.PILOTDECK_PROJECTS_GATEWAY_TIMEOUT_MS;

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    restoreEnv('PILOT_HOME', originalPilotHome);
    restoreEnv('PILOTDECK_PROJECTS_GATEWAY_TIMEOUT_MS', originalGatewayTimeout);
});

describe('projects gateway fallback', () => {
    it('loads Board project data from disk when the gateway is unavailable', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const pilotHome = makeTempDir('pilotdeck-projects-home-');
        const projectRoot = makeTempDir('pilotdeck-project-root-');
        const projectName = createProjectId(projectRoot);
        writeProjectMarker(pilotHome, projectRoot);
        writeSession(pilotHome, projectRoot, 'web:s_local', 'hello from local history');

        const { getProjects, getSessions } = await importProjectsWithUnavailableGateway(pilotHome);

        const projects = await getProjects();
        const project = projects.find((item) => item.fullPath === projectRoot);

        expect(projects[0]).toMatchObject({ name: 'general', fullPath: pilotHome });
        expect(project).toMatchObject({
            name: projectName,
            displayName: projectRoot.split('/').pop(),
            sessionMeta: { total: 1, hasMore: false },
        });
        expect(project.sessions).toHaveLength(1);
        expect(project.sessions[0]).toMatchObject({
            id: 'web:s_local',
            firstPrompt: 'hello from local history',
            __projectName: projectName,
        });

        const sessionsPage = await getSessions(projectName, 5, 0);

        expect(sessionsPage).toMatchObject({
            total: 1,
            hasMore: false,
            offset: 0,
            limit: 5,
        });
        expect(sessionsPage.sessions).toHaveLength(1);
        expect(sessionsPage.sessions[0]).toMatchObject({
            id: 'web:s_local',
            firstPrompt: 'hello from local history',
        });
    });
});

async function importProjectsWithUnavailableGateway(pilotHome) {
    process.env.PILOT_HOME = pilotHome;
    process.env.PILOTDECK_PROJECTS_GATEWAY_TIMEOUT_MS = '1';
    vi.doMock('./pilotdeck-bridge.js', () => ({
        getPilotDeckGateway: vi.fn(async () => {
            throw new Error('[pilotdeck-bridge] gateway connect failed after 1ms: Failed to connect to gateway WebSocket.');
        }),
        isGatewayUnavailableError: vi.fn((error) =>
            /gateway connect failed|failed to connect to gateway websocket/i.test(error?.message || String(error))),
    }));
    vi.doMock('./database/db.js', () => ({
        applyCustomSessionNames: vi.fn(),
    }));

    return import('./projects.js');
}

function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeProjectMarker(pilotHome, projectRoot) {
    const projectDir = join(pilotHome, 'projects', createProjectId(projectRoot));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.cwd'), `${projectRoot}\n`, 'utf-8');
}

function writeSession(pilotHome, projectRoot, sessionId, text) {
    const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
    mkdirSync(chatDir, { recursive: true });
    const entry = {
        type: 'accepted_input',
        createdAt: '2026-07-30T00:00:00.000Z',
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text }],
            },
        ],
    };
    writeFileSync(join(chatDir, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf-8');
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
