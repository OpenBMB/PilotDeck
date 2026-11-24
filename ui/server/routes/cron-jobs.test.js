import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronDeleteHandler, createCronUpdateHandler } from './cron-jobs.js';

const nativeFetch = globalThis.fetch;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Cron delete route', () => {
    const url = '/api/always-on/cron-jobs/task-1';
    const projectKey = 'C:\\work\\演示';

    it.each([
        ['JSON body', url, JSON.stringify({ projectKey }), projectKey],
        ['query parameter', `${url}?${new URLSearchParams({ projectKey })}`, undefined, projectKey],
        ['legacy task ID only', url, undefined, undefined],
    ])('forwards the project from a %s request', async (_label, path, body, expectedProjectKey) => {
        const cronDelete = vi.fn(async () => ({ deleted: true }));
        const response = await requestJson(createCronDeleteApp(cronDelete), path, { method: 'DELETE', body });

        expect(response).toEqual({ status: 200, body: { deleted: true } });
        expect(cronDelete).toHaveBeenCalledWith({ taskId: 'task-1', projectKey: expectedProjectKey, stopRunning: true });
    });

    it('returns a conflict when a legacy request matches several projects', async () => {
        const cronDelete = vi.fn(async () => {
            throw Object.assign(new Error('Ambiguous task'), { code: 'cron_task_ambiguous' });
        });
        const response = await requestJson(createCronDeleteApp(cronDelete), url, { method: 'DELETE' });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'cron_task_ambiguous' });
    });
});

describe('Cron update route', () => {
    it('returns 200, normalizes message and timezone, and preserves projectKey', async () => {
        const task = { taskId: 'task-1', revision: 4 };
        const cronUpdate = vi.fn(async () => ({ updated: true, task }));
        const { request } = createCronUpdateApp(cronUpdate);

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify({
                ...validPayload(),
                message: '  Generate report  ',
                projectKey: '/workspace/project ',
                timezone: '  Asia/Shanghai  ',
            }),
        });

        expect(response).toEqual({
            status: 200,
            body: { updated: true, task },
        });
        expect(cronUpdate).toHaveBeenCalledWith({
            taskId: 'task-1',
            message: 'Generate report',
            projectKey: '/workspace/project ',
            expectedRevision: 3,
            schedule: {
                type: 'cron',
                expression: '30 8 * * 1',
                timezone: 'Asia/Shanghai',
            },
            timezone: 'Asia/Shanghai',
        });
    });

    it.each([
        ['missing message', { message: '' }],
        ['missing projectKey', { projectKey: '' }],
        ['invalid schedule', { schedule: { type: 'cron', expression: '' } }],
        ['empty timezone', { timezone: '  ' }],
        ['non-string timezone', { timezone: null }],
        ['empty schedule timezone', { schedule: { type: 'cron', expression: '30 8 * * 1', timezone: '' } }],
        ['non-string schedule timezone', { schedule: { type: 'cron', expression: '30 8 * * 1', timezone: 8 } }],
        ['invalid revision', { expectedRevision: -1 }],
    ])('returns 400 for %s without calling the Gateway', async (_label, override) => {
        const cronUpdate = vi.fn();
        const { request } = createCronUpdateApp(cronUpdate);

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify({ ...validPayload(), ...override }),
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBeTruthy();
        expect(cronUpdate).not.toHaveBeenCalled();
    });

    it('returns 400 when the Cron runtime rejects the schedule', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cronUpdate = vi.fn(async () => {
            throw new Error('Invalid Cron timezone: Mars/Olympus');
        });
        const { request } = createCronUpdateApp(cronUpdate);

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify(validPayload()),
        });

        expect(response).toEqual({
            status: 400,
            body: { error: 'Invalid Cron timezone: Mars/Olympus' },
        });
    });

    it('returns 404 when the task does not exist in the workspace', async () => {
        const { request } = createCronUpdateApp(vi.fn(async () => ({ updated: false, reason: 'not_found' })));

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify(validPayload()),
        });

        expect(response).toEqual({
            status: 404,
            body: { error: 'Cron task was not found.', code: 'cron_not_found' },
        });
    });

    it.each([
        ['running', 'cron_running'],
        ['conflict', 'cron_conflict'],
    ])('returns 409 with %s details', async (reason, code) => {
        const { request } = createCronUpdateApp(vi.fn(async () => ({ updated: false, reason })));

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify(validPayload()),
        });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code });
    });

    it('returns 500 when the Gateway fails unexpectedly', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const cronUpdate = vi.fn(async () => {
            throw new Error('Gateway unavailable');
        });
        const { request } = createCronUpdateApp(cronUpdate);

        const response = await request('/api/always-on/cron-jobs/task-1', {
            method: 'PATCH',
            body: JSON.stringify(validPayload()),
        });

        expect(response).toEqual({
            status: 500,
            body: { error: 'Gateway unavailable' },
        });
    });
});

function validPayload() {
    return {
        message: 'Generate report',
        projectKey: '/workspace/project',
        expectedRevision: 3,
        schedule: {
            type: 'cron',
            expression: '30 8 * * 1',
            timezone: 'Asia/Shanghai',
        },
        timezone: 'Asia/Shanghai',
    };
}

function createCronUpdateApp(cronUpdate) {
    const app = express();
    app.use(express.json());
    app.patch('/api/always-on/cron-jobs/:taskId', createCronUpdateHandler({
        getGateway: vi.fn(async () => ({ cronUpdate })),
    }));
    return {
        request: (path, init) => requestJson(app, path, init),
    };
}

function createCronDeleteApp(cronDelete) {
    const app = express();
    app.use(express.json());
    app.delete('/api/always-on/cron-jobs/:taskId', createCronDeleteHandler({
        getGateway: vi.fn(async () => ({ cronDelete })),
    }));
    return app;
}

async function requestJson(app, path, init = {}) {
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
            headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
            ...init,
        });
        return {
            status: response.status,
            body: await response.json(),
        };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}
