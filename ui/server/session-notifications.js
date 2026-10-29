import { notificationText } from '../shared/notifications.js';

export function sessionAttention(frame) {
    const run = frame.runId || frame.id;
    if (frame.kind === 'complete' && frame.finishReason === 'completed' && frame.success !== false && run) {
        return { id: run, kind: 'completed' };
    }
    if (frame.kind === 'permission_request' || frame.kind === 'interactive_prompt') {
        const question = /^(ask_?user_?question|AskUserQuestion)$/i.test(frame.toolName || '') || frame.kind === 'interactive_prompt';
        const id = frame.requestId || frame.toolCallId || frame.id;
        if (id) return { id: `${question ? 'question' : 'approval'}:${id}`, kind: question ? 'question' : 'approval' };
    }
    if (frame.kind === 'error' && frame.terminal !== false && run) return { id: `error:${run}`, kind: 'error' };
    if (frame.type === 'input-queue-state') {
        const failed = frame.items?.find(item => ['failed', 'delivery_uncertain'].includes(item.status));
        if (failed) return { id: `error:${failed.id}`, kind: 'error' };
    }
    return null;
}

/** Per-user, bounded summaries; full messages remain on the session-scoped stream. */
export function createSessionNotificationRegistry() {
    const sessions = new Map();
    const seen = new Map();
    return {
        remove(userId, sessionId) { sessions.delete(JSON.stringify([userId, sessionId])); },
        receive(userId, frame) {
            if (!frame?.sessionId || frame.isSubagentContainer || frame.parentToolUseId) return null;
            const key = JSON.stringify([userId, frame.sessionId]);
            const previous = sessions.get(key);
            const startsRun = (frame.kind === 'status' && frame.text === 'started') || (frame.kind === 'text' && frame.role === 'user');
            if (previous?.runId && frame.runId && previous.runId !== frame.runId && !startsRun) return null;
            const freshRun = frame.runId && frame.runId !== previous?.runId;
            const state = { ...(previous || {}), ...(freshRun ? { preview: '' } : {}) };
            if (frame.runId) state.runId = frame.runId;
            if (frame.kind === 'text' && frame.role === 'user' && !state.sessionName) state.sessionName = notificationText(frame.content, 80);
            if (frame.kind === 'text' && frame.role === 'assistant') state.preview = notificationText(frame.content);
            sessions.delete(key);
            sessions.set(key, state);
            if (sessions.size > 2048) sessions.delete(sessions.keys().next().value);
            const attention = sessionAttention(frame);
            if (!attention) return null;
            const id = JSON.stringify([String(userId ?? 'local'), frame.sessionId, attention.id]);
            if (seen.has(id)) return null;
            seen.set(id, true);
            if (seen.size > 4096) seen.delete(seen.keys().next().value);
            const questions = frame.input?.questions || frame.questions;
            const question = Array.isArray(questions) ? questions.map(q => q.question || q.header || '').join(' ') : '';
            // A read watermark must distinguish separate reminders even when
            // their source frames share a millisecond or the clock moves back.
            const timestamp = Date.parse(frame.timestamp);
            state.attentionAt = new Date(Math.max(Number.isFinite(timestamp) ? timestamp : Date.now(),
                (Date.parse(previous?.attentionAt) || 0) + 1)).toISOString();
            const failedInput = frame.type === 'input-queue-state'
                ? frame.items?.find(item => ['failed', 'delivery_uncertain'].includes(item.status)) : null;
            return {
                id: attention.id, sessionId: frame.sessionId, scope: String(userId ?? 'local'), kind: attention.kind,
                taskId: failedInput ? failedInput.runId || failedInput.id : frame.runId || state.runId || attention.id,
                sessionName: state.sessionName, createdAt: state.attentionAt,
                preview: attention.kind === 'completed' ? state.preview : attention.kind === 'error'
                    ? notificationText(frame.userHint || frame.content || frame.items?.find(item => item.error)?.error)
                    : notificationText(question || frame.input?.description || frame.toolName || frame.content),
            };
        },
    };
}
