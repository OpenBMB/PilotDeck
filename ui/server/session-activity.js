import { sessionAttention } from './session-notifications.js';

/** Lightweight sidebar metadata; never broadcast chat content to unrelated views. */
export function createSessionActivityRegistry() {
    const users = new Map();
    const pendingRequests = new Map();
    let revision = 0;
    return {
        remove(userId, sessionId) { users.get(userId)?.delete(sessionId); pendingRequests.delete(JSON.stringify([userId, sessionId])); },
        snapshot(userId) {
            return [...(users.get(userId)?.values() || [])];
        },
        receive(userId, frame) {
            const sessionId = frame?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId) return null;
            const sessions = users.get(userId) || new Map();
            const previous = sessions.get(sessionId);
            const startsRun = (frame.kind === 'status' && frame.text === 'started') || (frame.kind === 'text' && frame.role === 'user');
            if (!previous && frame.kind === 'permission_cancelled') return null;
            if (previous?.runId && frame.runId && previous.runId !== frame.runId && !startsRun) return null;
            const key = JSON.stringify([userId, sessionId]);
            const pending = new Map(pendingRequests.get(key) || []);
            if (startsRun && frame.runId !== previous?.runId) pending.clear();
            let runId = frame.runId;
            let processing;
            let completedRunId = previous?.completedRunId;
            const attention = sessionAttention(frame);
            if (frame.kind === 'status' && frame.text === 'started') processing = true;
            else if (frame.kind === 'text' && frame.role === 'user') processing = true;
            else if (frame.kind === 'complete') {
                if (previous?.processing && runId && previous.runId && runId !== previous.runId) return null;
                processing = false;
                if (frame.finishReason === 'completed' && frame.success !== false) completedRunId = runId || frame.id;
            } else if (frame.kind === 'interrupted' || (frame.kind === 'error' && frame.terminal !== false)) {
                if (previous?.runId && runId && previous.runId !== runId) return null;
                processing = false;
            } else if (frame.type === 'input-queue-state') {
                const sending = frame.items?.find(item => ['submitting', 'dispatching'].includes(item.status));
                if (sending) { processing = true; runId = sending.runId || sending.id; }
                else if (frame.items?.some(item => ['failed', 'delivery_uncertain'].includes(item.status) && item.id === previous?.runId)) processing = false;
                else return null;
            } else if (attention || frame.kind === 'permission_cancelled' || (frame.kind === 'tool_result' && pending.size)) processing = previous?.processing ?? true;
            else return null;
            // Replayed start/user frames must not resurrect a completed turn.
            runId ||= previous?.runId;
            if (processing && previous && !previous.processing && runId === previous.runId) return null;
            if (attention && ['question', 'approval'].includes(attention.kind)) {
                pending.set(frame.requestId || frame.toolCallId || frame.id, { kind: attention.kind, toolId: frame.toolCallId });
            }
            if (frame.kind === 'permission_cancelled') pending.delete(frame.requestId);
            if (frame.kind === 'tool_result' && frame.toolId) {
                for (const [id, request] of pending) if (request.toolId === frame.toolId) pending.delete(id);
            }
            if (!processing) pending.clear();
            if (pending.size) pendingRequests.set(key, pending); else pendingRequests.delete(key);
            const waitingFor = [...pending.values()].some(request => request.kind === 'question') ? 'question' : pending.size ? 'approval' : null;
            const attentionId = attention?.id || previous?.attentionId;
            if (previous && previous.processing === processing && previous.runId === runId && previous.completedRunId === completedRunId && previous.attentionId === attentionId && previous.waitingFor === waitingFor) return null;
            const attentionAt = attention && attention.id !== previous?.attentionId ? frame.timestamp || new Date().toISOString() : previous?.attentionAt;
            const activity = {sessionId, runId, processing, waitingFor, completedRunId, attentionId, attentionAt, revision: ++revision};
            sessions.delete(sessionId);
            sessions.set(sessionId, activity);
            if (sessions.size > 2048) {
                // Never evict running tasks; terminal records are only reconnect hints.
                const oldest = [...sessions].find(([, item]) => !item.processing);
                if (oldest) sessions.delete(oldest[0]);
            }
            users.set(userId, sessions);
            return activity;
        },
    };
}

/** Background turns have no originating socket; resolve the instance owner,
 * record activity even with no watchers, and keep full frames session-scoped. */
export function createBackgroundSessionForwarder({ getUserId, broadcastActivity, forwardToWatchers }) {
    return (sessionId, frame) => {
        const userId = getUserId();
        if (userId === undefined || userId === null) return;
        broadcastActivity(frame, userId);
        forwardToWatchers(sessionId, frame, userId);
    };
}
