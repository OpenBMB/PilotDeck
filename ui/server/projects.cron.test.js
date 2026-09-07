import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
    cronList: vi.fn(),
}));

vi.mock('./pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => gateway),
    isGatewayUnavailableError: () => false,
    withPilotDeckGatewayReadRetry: vi.fn(async (operation) => operation(gateway)),
}));

import { getProjectCronJobsOverview } from './projects.js';

describe('getProjectCronJobsOverview', () => {
    beforeEach(() => {
        gateway.cronList.mockReset();
    });

    it('returns editable schedules and keeps the legacy cron field', async () => {
        gateway.cronList.mockResolvedValue({
            tasks: [
                {
                    taskId: 'weekly-task',
                    message: 'Weekly report',
                    projectKey: '/workspace/project',
                    schedule: {
                        type: 'cron',
                        expression: '30 8 * * 1',
                        timezone: 'Asia/Shanghai',
                    },
                    status: 'scheduled',
                    createdAt: '2026-08-01T00:00:00.000Z',
                    updatedAt: '2026-08-02T00:00:00.000Z',
                    revision: 3,
                },
                {
                    taskId: 'once-task',
                    message: 'One-time report',
                    projectKey: '/workspace/project',
                    schedule: {
                        type: 'once',
                        runAt: '2026-08-05T08:00:00.000Z',
                    },
                    timezone: 'America/New_York',
                    status: 'scheduled',
                    createdAt: '2026-08-01T00:00:00.000Z',
                    updatedAt: '2026-08-02T00:00:00.000Z',
                },
            ],
            recentRuns: [],
        });

        const result = await getProjectCronJobsOverview();

        expect(result.jobs).toEqual([
            expect.objectContaining({
                id: 'weekly-task',
                cron: '30 8 * * 1',
                schedule: {
                    type: 'cron',
                    expression: '30 8 * * 1',
                    timezone: 'Asia/Shanghai',
                },
                timezone: 'Asia/Shanghai',
                revision: 3,
            }),
            expect.objectContaining({
                id: 'once-task',
                cron: '',
                schedule: {
                    type: 'once',
                    runAt: '2026-08-05T08:00:00.000Z',
                },
                timezone: 'America/New_York',
                revision: 0,
            }),
        ]);
    });
});
