export function createCronUpdateHandler({ getGateway }) {
    return async function handleCronUpdate(req, res) {
        try {
            const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
            const projectKey = typeof req.body?.projectKey === 'string' ? req.body.projectKey : '';
            const schedule = req.body?.schedule;
            const timezone = typeof req.body?.timezone === 'string' && req.body.timezone.trim()
                ? req.body.timezone.trim()
                : undefined;
            const expectedRevision = req.body?.expectedRevision;

            if (!message) {
                res.status(400).json({ error: 'Cron message is required.' });
                return;
            }
            if (!projectKey) {
                res.status(400).json({ error: 'Cron projectKey is required.' });
                return;
            }
            if (!isCronTaskSchedule(schedule)) {
                res.status(400).json({ error: 'Cron schedule is invalid.' });
                return;
            }
            if (hasInvalidTimezone(req.body)) {
                res.status(400).json({ error: 'Cron timezone is invalid.' });
                return;
            }
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
                res.status(400).json({ error: 'Cron expectedRevision must be a non-negative integer.' });
                return;
            }

            const gateway = await getGateway();
            const result = await gateway.cronUpdate({
                taskId: req.params.taskId,
                projectKey,
                expectedRevision,
                message,
                schedule,
                timezone,
            });
            if (!result.updated) {
                if (result.reason === 'running') {
                    res.status(409).json({
                        error: 'Cron task is running. Stop it before editing.',
                        code: 'cron_running',
                    });
                    return;
                }
                if (result.reason === 'conflict') {
                    res.status(409).json({
                        error: 'Cron task changed. Refresh and try again.',
                        code: 'cron_conflict',
                    });
                    return;
                }
                res.status(404).json({ error: 'Cron task was not found.', code: 'cron_not_found' });
                return;
            }
            res.json(result);
        } catch (error) {
            console.error('[always-on-cron-update] failed:', error);
            const status = isCronValidationError(error) ? 400 : 500;
            res.status(status).json({ error: error?.message || 'cron update failed' });
        }
    };
}

function isCronTaskSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
        return false;
    }
    if (schedule.type === 'once') {
        return typeof schedule.runAt === 'string' && schedule.runAt.trim().length > 0;
    }
    if (schedule.type === 'cron') {
        return typeof schedule.expression === 'string'
            && schedule.expression.trim().length > 0
            && !hasInvalidTimezone(schedule);
    }
    return false;
}

function hasInvalidTimezone(value) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'timezone')) {
        return false;
    }
    return typeof value.timezone !== 'string' || value.timezone.trim().length === 0;
}

function isCronValidationError(error) {
    const message = error instanceof Error ? error.message : String(error || '');
    return /^(Invalid Cron|Cron (expression|timezone|schedule|task|delay)|One-time Cron)/i.test(message);
}
