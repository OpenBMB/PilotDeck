import { mapCronRunOutcome } from '../../../src/cron/protocol/types.js';

export function cronTaskOverview(task, latestRun = task.lastRun || null) {
    const isCron = task.schedule?.type === 'cron';
    return {
        id: task.taskId,
        sessionKey: task.sessionKey,
        updatedAt: task.updatedAt,
        projectKey: task.projectKey || null,
        cron: isCron ? task.schedule.expression : '',
        schedule: task.schedule,
        timezone: task.timezone || task.schedule?.timezone || null,
        revision: Number.isSafeInteger(task.revision) && task.revision >= 0 ? task.revision : 0,
        name: task.name || task.message?.split('\n')[0]?.slice(0, 120) || '',
        prompt: task.message || '',
        workspaceCwd: task.workspaceCwd || task.projectKey,
        executionMode: task.executionMode || 'persistent',
        enabled: task.enabled !== false,
        notificationPolicy: task.notificationPolicy || 'all',
        reminderTiming: task.reminderTiming,
        workspaceMode: task.workspaceMode || 'local',
        mode: task.mode || 'default',
        modelSelection: task.modelSelection,
        originSessionKey: task.originSessionKey,
        targetSessionKey: task.targetSessionKey,
        lastRun: task.lastRun || latestRun,
        statusDetail: task.statusDetail,
        createdAt: task.createdAt,
        nextRunAt: task.nextRunAt,
        recurring: task.schedule?.type !== 'once',
        permanent: task.schedule?.type !== 'once',
        manualOnly: false,
        status: task.status,
        lastFiredAt: latestRun?.startedAt ? new Date(latestRun.startedAt).getTime() : undefined,
        latestRun: latestRun ? {
            status: mapCronRunOutcome(latestRun.outcome, latestRun.finishedAt),
            runId: latestRun.runId,
            startedAt: latestRun.startedAt,
            taskId: latestRun.taskId,
            sessionId: latestRun.sessionKey,
        } : null,
    };
}
