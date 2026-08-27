import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    beginActivitySnapshotRead,
    createAlwaysOnTurnEventForwarder,
    gatewayEventToFrames,
    getFallbackSessionActivity,
    getQueuedInputSteerError,
    hydrateQueuedInputOptions,
    isGatewayUnavailableError,
    isTerminalAlwaysOnTurnEvent,
    queuedInputDispositionAfterTurn,
    reconcileRecoveredQueueItems,
    resetSteeringItemForRun,
    resumeInputQueueState,
    scheduleQueuedDispatchAfterActivityCheck,
    setLocalActiveRun,
    resolveTurnRunId,
    resolveInputQueueProjectKey,
    restoreQueuedInputFromStorage,
    serializeQueuedInputForStorage,
    syncLocalActiveRunFromSnapshot,
    uiFilesToAttachments,
} from './pilotdeck-bridge.js';

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('queued input persistence', () => {
    it('lets an explicit project path repair a session first watched without project context', () => {
        expect(resolveInputQueueProjectKey(
            { projectKey: '/tmp/pilot-home' },
            { projectPath: '/workspace/project' },
            '/tmp/pilot-home',
        )).toBe('/workspace/project');
    });

    it('stores uploaded images by path and restores their data URL on dispatch', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pilotdeck-queue-image-'));
        const imagePath = join(root, 'image.png');
        try {
            await writeFile(imagePath, Buffer.from('queued-image'));
            const stored = serializeQueuedInputForStorage({
                id: 'queue-1',
                status: 'steering',
                steerTargetRunId: 'run-active',
                options: {
                    images: [{
                        name: 'image.png',
                        path: imagePath,
                        mimeType: 'image/png',
                        data: 'data:image/png;base64,stale',
                    }],
                },
            });

            expect(stored).toMatchObject({
                status: 'delivery_uncertain',
                deliveryKind: 'steer',
                deliveryRunId: 'run-active',
            });
            expect(stored.steerTargetRunId).toBeUndefined();
            expect(stored.options.images[0].data).toBeUndefined();
            expect(hydrateQueuedInputOptions(stored.options).images[0]).toMatchObject({
                path: imagePath,
                data: `data:image/png;base64,${Buffer.from('queued-image').toString('base64')}`,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps pathless region captures inline because they cannot be reloaded from disk', () => {
        const stored = serializeQueuedInputForStorage({
            id: 'queue-1',
            options: { images: [{ name: 'region.png', data: 'data:image/png;base64,abc' }] },
        });

        expect(stored.options.images[0].data).toBe('data:image/png;base64,abc');
    });

    it('preserves uncertain delivery state across repeated persistence', () => {
        const restored = restoreQueuedInputFromStorage(serializeQueuedInputForStorage({
            id: 'queue-dispatch',
            runId: 'run-dispatch',
            command: 'Continue',
            status: 'dispatching',
            options: {},
        }));

        expect(restored).toMatchObject({
            status: 'delivery_uncertain',
            deliveryKind: 'dispatch',
            deliveryRunId: 'run-dispatch',
        });
        expect(serializeQueuedInputForStorage(restored)).toMatchObject({
            status: 'delivery_uncertain',
            deliveryKind: 'dispatch',
            deliveryRunId: 'run-dispatch',
        });
    });

    it('removes recovered deliveries only after input acceptance or durable transcript evidence', () => {
        const items = [
            {
                id: 'dispatch-active',
                status: 'delivery_uncertain',
                deliveryKind: 'dispatch',
                deliveryRunId: 'run-active',
            },
            {
                id: 'steer-recorded',
                status: 'delivery_uncertain',
                deliveryKind: 'steer',
                deliveryRunId: 'run-old',
            },
            { id: 'still-queued', status: 'queued' },
        ];

        expect(reconcileRecoveredQueueItems(items, {
            activeRunId: 'run-active',
            activeEvents: [{ type: 'input_accepted', runId: 'run-active' }],
            messages: [{ queueItemId: 'steer-recorded' }],
            complete: true,
        })).toEqual([{ id: 'still-queued', status: 'queued' }]);
    });

    it('does not treat an active reservation or status-only history as accepted input', () => {
        const uncertain = {
            id: 'dispatch-preflight',
            status: 'delivery_uncertain',
            deliveryKind: 'dispatch',
            deliveryRunId: 'run-preflight',
        };

        expect(reconcileRecoveredQueueItems([uncertain], {
            activeRunId: 'run-preflight',
            messages: [],
            complete: false,
        })).toEqual([uncertain]);
        expect(reconcileRecoveredQueueItems([uncertain], {
            messages: [{ role: 'error', kind: 'error', turnId: 'run-preflight' }],
            complete: true,
        })).toEqual([{
            id: 'dispatch-preflight',
            status: 'queued',
        }]);
    });

    it('does not silently retry a steer that may still be waiting in an active mailbox', () => {
        const uncertain = {
            id: 'steer-pending',
            status: 'delivery_uncertain',
            deliveryKind: 'steer',
            deliveryRunId: 'run-active',
        };

        expect(reconcileRecoveredQueueItems([uncertain], {
            activeRunId: 'run-active',
            messages: [],
            complete: true,
        })).toEqual([uncertain]);
        expect(reconcileRecoveredQueueItems([uncertain], {
            activeRunId: 'run-active',
            activeEvents: [{ type: 'steer_applied', itemId: 'steer-pending' }],
            messages: [],
            complete: true,
        })).toEqual([]);
    });

    it('requeues recovered guidance after the active turn reports it was not applied', () => {
        expect(reconcileRecoveredQueueItems([{
            id: 'steer-unapplied',
            status: 'delivery_uncertain',
            deliveryKind: 'steer',
            deliveryRunId: 'run-active',
        }], {
            activeRunId: 'run-active',
            activeEvents: [{
                type: 'steer_unapplied',
                itemId: 'steer-unapplied',
                runId: 'run-active',
            }],
            complete: false,
        })).toEqual([{
            id: 'steer-unapplied',
            status: 'queued',
        }]);
    });

    it('only returns an unobserved uncertain delivery to queued after complete evidence', () => {
        const uncertain = {
            id: 'dispatch-missing',
            status: 'delivery_uncertain',
            deliveryKind: 'dispatch',
            deliveryRunId: 'run-missing',
        };

        expect(reconcileRecoveredQueueItems([uncertain], { complete: false })).toEqual([uncertain]);
        expect(reconcileRecoveredQueueItems([uncertain], { complete: true })).toEqual([
            { id: 'dispatch-missing', status: 'queued' },
        ]);
    });
});

describe('queued input turn boundaries', () => {
    it('dispatches after natural completion but pauses after Stop or failure', () => {
        expect(queuedInputDispositionAfterTurn('completed', false)).toBe('dispatch');
        expect(queuedInputDispositionAfterTurn('completed', true)).toBe('keep');
        expect(queuedInputDispositionAfterTurn('aborted_streaming', true)).toBe('pause');
        expect(queuedInputDispositionAfterTurn('tool_error', false)).toBe('pause');
    });
});

describe('turn run identity', () => {
    it('reuses a non-empty client run id', () => {
        expect(resolveTurnRunId('  run-user-1  ')).toBe('run-user-1');
    });

    it('generates a UUID when a legacy client omits the run id', () => {
        expect(resolveTurnRunId(undefined)).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
    });
});

describe('activity snapshot ordering', () => {
    it('does not let a snapshot overwrite a run that started while the request was pending', () => {
        const state = {
            active: false,
            runId: undefined,
            activityRevision: 0,
            activitySnapshotSequence: 0,
        };
        const guard = beginActivitySnapshotRead(state);

        setLocalActiveRun(state, 'run-new');
        const result = syncLocalActiveRunFromSnapshot(
            state,
            { active: true, runId: 'run-old' },
            guard,
            { emit: false },
        );

        expect(result).toMatchObject({ applied: false, reason: 'local_state_changed' });
        expect(state).toMatchObject({ active: true, runId: 'run-new' });
    });

    it('ignores an older snapshot even when a newer identical snapshot made no state change', () => {
        const state = {
            active: false,
            runId: undefined,
            activityRevision: 0,
            activitySnapshotSequence: 0,
        };
        const olderGuard = beginActivitySnapshotRead(state);
        const newerGuard = beginActivitySnapshotRead(state);

        expect(syncLocalActiveRunFromSnapshot(
            state,
            { active: false },
            newerGuard,
            { emit: false },
        )).toMatchObject({ applied: true, changed: false });
        expect(syncLocalActiveRunFromSnapshot(
            state,
            { active: true, runId: 'run-stale' },
            olderGuard,
            { emit: false },
        )).toMatchObject({ applied: false, reason: 'stale_request' });
        expect(state).toMatchObject({ active: false, runId: undefined });
    });

    it('does not clear a local run before the gateway has acknowledged it', () => {
        const state = {
            active: true,
            runId: 'run-pending',
            pendingGatewayRunId: 'run-pending',
            activityRevision: 1,
            activitySnapshotSequence: 0,
        };
        const guard = beginActivitySnapshotRead(state);

        expect(syncLocalActiveRunFromSnapshot(
            state,
            { active: false },
            guard,
            { emit: false },
        )).toMatchObject({ applied: false, reason: 'pending_local_run' });
        expect(state).toMatchObject({
            active: true,
            runId: 'run-pending',
            pendingGatewayRunId: 'run-pending',
        });
    });

    it('accepts a snapshot that confirms the pending local run', () => {
        const state = {
            active: true,
            runId: 'run-pending',
            pendingGatewayRunId: 'run-pending',
            activityRevision: 1,
            activitySnapshotSequence: 0,
        };
        const guard = beginActivitySnapshotRead(state);

        expect(syncLocalActiveRunFromSnapshot(
            state,
            { active: true, runId: 'run-pending' },
            guard,
            { emit: false },
        )).toMatchObject({ applied: true, changed: false });
        expect(state.pendingGatewayRunId).toBeUndefined();
    });

    it('runs the gateway activity check in the background', async () => {
        const snapshot = deferred();
        const dispatch = vi.fn();
        const state = {
            sessionKey: 'web:s_test',
            active: false,
            runId: undefined,
            queuePaused: false,
            queueDispatchCheckPromise: null,
            activityRevision: 0,
            activitySnapshotSequence: 0,
        };

        const returned = scheduleQueuedDispatchAfterActivityCheck(
            state,
            { send: vi.fn() },
            'pilotdeck',
            {
                getGateway: async () => ({
                    getActiveTurnSnapshot: () => snapshot.promise,
                }),
                dispatch,
            },
        );

        expect(returned).toBeUndefined();
        expect(state.queueDispatchCheckPromise).toBeInstanceOf(Promise);
        expect(dispatch).not.toHaveBeenCalled();

        snapshot.resolve({ active: true, runId: 'run-existing' });
        await state.queueDispatchCheckPromise;
        expect(state).toMatchObject({ active: true, runId: 'run-existing' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('routes queue resume through the protected activity check before dispatching', () => {
        const scheduleDispatch = vi.fn();
        const writer = { send: vi.fn() };
        const state = {
            sessionKey: 'web:s_resume',
            projectKey: '',
            inputQueue: [{
                id: 'queued-one',
                command: 'Continue with this',
                displayText: 'Continue with this',
                createdAt: Date.now(),
                status: 'queued',
                options: {},
            }],
            active: false,
            runId: undefined,
            queuePaused: true,
            queuePauseReason: 'user_stopped',
            queueRevision: 0,
        };

        const result = resumeInputQueueState(
            state,
            writer,
            'pilotdeck',
            { scheduleDispatch },
        );

        expect(result).toMatchObject({ ok: true });
        expect(state.queuePaused).toBe(false);
        expect(scheduleDispatch).toHaveBeenCalledOnce();
        expect(scheduleDispatch).toHaveBeenCalledWith(state, writer, 'pilotdeck');
    });
});

describe('steer run identity', () => {
    it('rejects stale steer requests after dispatch starts or the queue pauses', () => {
        expect(getQueuedInputSteerError(
            { queuePaused: false },
            { status: 'dispatching' },
        )).toBe('This message is already being sent.');
        expect(getQueuedInputSteerError(
            { queuePaused: true },
            { status: 'queued' },
        )).toBe('The queue is paused; resume it before adjusting direction.');
        expect(getQueuedInputSteerError(
            { queuePaused: false },
            { status: 'queued' },
        )).toBeNull();
    });

    it('only resets steering state for the run originally targeted', () => {
        const state = {
            inputQueue: [{
                id: 'queue-1',
                status: 'steering',
                steerTargetRunId: 'run-original',
                options: {},
            }],
            queueRevision: 0,
            queuePaused: false,
            sessionKey: 'web:s_test',
        };

        expect(resetSteeringItemForRun(state, 'queue-1', 'run-replacement')).toBe(false);
        expect(state.inputQueue[0].status).toBe('steering');
        expect(resetSteeringItemForRun(state, 'queue-1', 'run-original')).toBe(true);
        expect(state.inputQueue[0]).toMatchObject({ status: 'queued' });
        expect(state.inputQueue[0].steerTargetRunId).toBeUndefined();
    });
});

describe('web attachment conversion', () => {
    it('marks uploaded files with the web channel key', () => {
        expect(uiFilesToAttachments([{
            name: 'meeting.wav',
            path: '/tmp/meeting.wav',
            mimeType: 'audio/wav',
            size: 42,
        }])).toEqual([expect.objectContaining({
            type: 'file',
            path: '/tmp/meeting.wav',
            metadata: { channelKey: 'web' },
        })]);
    });
});

describe('session activity fallback', () => {
    it('reports unknown while preserving a locally known run id', () => {
        expect(getFallbackSessionActivity({ active: true, runId: 'run-local' })).toEqual({
            isProcessing: null,
            activeRunId: 'run-local',
            activeTurnMessages: [],
        });
    });

    it('reports unknown instead of false when local state cannot prove inactivity', () => {
        expect(getFallbackSessionActivity(undefined)).toEqual({
            isProcessing: null,
            activeRunId: null,
            activeTurnMessages: [],
        });
        expect(getFallbackSessionActivity({ active: false, runId: undefined })).toEqual({
            isProcessing: null,
            activeRunId: null,
            activeTurnMessages: [],
        });
    });
});

describe('gatewayEventToFrames agent status errors', () => {
    it('keeps unapplied guidance as queue state instead of rendering a user message', () => {
        expect(gatewayEventToFrames({
            type: 'steer_unapplied',
            itemId: 'queue-1',
            reason: 'turn_ended',
        }, 'web:s_test', 'pilotdeck')).toEqual([]);
    });

    it('renders applied guidance as a user message with its queue identity', () => {
        const frames = gatewayEventToFrames({
            type: 'steer_applied',
            itemId: 'queue-1',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Use HTML instead' }],
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'text',
            role: 'user',
            content: 'Use HTML instead',
            queueItemId: 'queue-1',
            isSteer: true,
        });
    });

    it('normalizes hydrated guidance images to the data URLs expected by the UI', () => {
        const frames = gatewayEventToFrames({
            type: 'steer_applied',
            itemId: 'queue-image',
            displayText: 'Use this image',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Use this image' }],
            },
            images: [
                { name: 'reference.png', data: 'data:image/png;base64,abc' },
                'data:image/jpeg;base64,def',
                { name: 'missing-data.png' },
            ],
        }, 'web:s_test', 'pilotdeck');

        expect(frames[0].images).toEqual([
            'data:image/png;base64,abc',
            'data:image/jpeg;base64,def',
        ]);
    });

    it('maps tool result detail availability to a mergeable tool_result frame', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_result_detail_available',
            toolCallId: 'call-large',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
            fullText: 'x'.repeat(100000),
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'tool_result',
            toolId: 'call-large',
            content: 'Full tool result persisted at /tmp/pilotdeck/tool-result.txt',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
        });
        expect(frames[0].fullText).toBeUndefined();
    });

    it('bounds live tool result previews before they reach React state', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_call_finished',
            toolCallId: 'call-large',
            ok: true,
            resultPreview: `head\n${'x'.repeat(50000)}\ntail`,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('tool_result');
        expect(frames[0].content.length).toBeLessThan(22000);
        expect(frames[0].content).toContain('UI preview truncated');
        expect(frames[0].content).toContain('head');
        expect(frames[0].content).toContain('tail');
    });

    it('uses detail.userHint for model_empty_response_exhausted', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_empty_response_exhausted',
            detail: {
                message: 'The model returned empty content repeatedly.',
                userHint: 'Increase max output tokens.',
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            terminal: true,
            content: 'The model returned empty content repeatedly.',
            code: 'model_empty_response_exhausted',
            userHint: 'Increase max output tokens.',
        });
    });

    it('renders new semantic status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_request_failed',
            detail: {
                message: 'Provider rejected the request.',
                messageI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
                userHint: 'Check provider settings.',
                userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            terminal: true,
            content: 'Provider rejected the request.',
            contentI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
            code: 'model_request_failed',
            userHint: 'Check provider settings.',
            userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
        });
    });

    it('renders bridge visible failure status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_bridge_error',
            detail: {
                message: 'Bridge crashed while streaming.',
                code: 'gateway_bridge_error',
                severity: 'error',
                visible: true,
                userHint: 'Check UI server logs.',
                scope: 'turn',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            terminal: true,
            content: 'Bridge crashed while streaming.',
            code: 'gateway_bridge_error',
            userHint: 'Check UI server logs.',
        });
    });

    it('carries post-compact token budget on compact boundary frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'compact_completed',
            detail: {
                compactionId: 'compact-reactive-1',
                trigger: 'reactive',
                preTokens: 76000,
                postTokens: 12000,
                messagesSummarized: 8,
                tokenBudget: {
                    used: 12000,
                    displayUsed: 12000,
                    budgetUsed: 12000,
                    total: 100000,
                    effectiveTotal: 90000,
                    state: 'ok',
                    source: 'compact',
                },
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            id: 'compact_boundary:web:s_test:unknown-run:compact-reactive-1',
            kind: 'compact_boundary',
            compactionId: 'compact-reactive-1',
            trigger: 'reactive',
            postTokens: 12000,
            tokenBudget: {
                used: 12000,
                total: 100000,
                state: 'ok',
                source: 'compact',
            },
        });
    });

    it('gives replayed compact boundaries a stable id', () => {
        const event = {
            type: 'agent_status',
            event: 'compact_completed',
            runId: 'run-1',
            detail: {
                compactionId: 'compact-1',
                trigger: 'auto',
                preTokens: 100,
                postTokens: 40,
            },
        };

        const first = gatewayEventToFrames(event, 'web:s_test', 'pilotdeck')[0];
        const replayed = gatewayEventToFrames(event, 'web:s_test', 'pilotdeck')[0];

        expect(first.id).toBe('compact_boundary:web:s_test:run-1:compact-1');
        expect(replayed.id).toBe(first.id);
    });

    it('preserves the parent run on subagent activity frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            runId: 'run-parent',
            event: 'subagent_started',
            detail: {
                subagentId: 'child-parent-run-test',
                subagentType: 'general-purpose',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames.find((frame) => frame.kind === 'agent_activity')).toMatchObject({
            runId: 'subagent:child-parent-run-test',
            parentRunId: 'run-parent',
            activityId: 'subagent:child-parent-run-test',
        });
    });

    it('maps an aborted subagent completion to a cancelled activity', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            runId: 'run-parent',
            event: 'subagent_completed',
            detail: {
                subagentId: 'child-aborted',
                subagentType: 'general-purpose',
                success: false,
                aborted: true,
                durationMs: 100,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames.find((frame) => frame.kind === 'agent_activity')).toMatchObject({
            parentRunId: 'run-parent',
            activityId: 'subagent:child-aborted',
            state: 'cancelled',
            detail: '已停止',
            title: 'Subagent general-purpose stopped',
        });
    });

    it('renders gateway unavailable preflight status as an error frame', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_unavailable',
            detail: {
                message: 'PilotDeck gateway is unavailable.',
                code: 'gateway_unavailable',
                severity: 'error',
                visible: true,
                userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
                scope: 'preflight',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            terminal: true,
            content: 'PilotDeck gateway is unavailable.',
            code: 'gateway_unavailable',
            userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
        });
    });
});

describe('isGatewayUnavailableError', () => {
    it('detects cached gateway websocket disconnects', () => {
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket is not connected.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket closed.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway closed during hello: auth_failed'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('[pilotdeck-bridge] gateway connect failed after 60000ms'))).toBe(true);
    });

    it('does not classify generic bridge failures as gateway unavailable', () => {
        expect(isGatewayUnavailableError(new Error('Unexpected frame payload'))).toBe(false);
    });
});

describe('Always-On turn notification forwarding', () => {
    it('cleans an aborted run so its next run receives session_created again', () => {
        const forwarded = [];
        const forward = createAlwaysOnTurnEventForwarder((sessionId, frame) => {
            forwarded.push({ sessionId, frame });
        });
        const payload = (event) => ({
            sessionKey: 'cron:task-1',
            channelKey: 'cron',
            event,
        });

        forward('always-on:turn-event', payload({
            type: 'agent_status',
            event: 'subagent_started',
            detail: { subagentId: 'child-1', subagentType: 'general-purpose' },
        }));
        forward('always-on:turn-event', payload({
            type: 'error',
            code: 'agent_aborted',
            message: 'The run was stopped.',
            recoverable: true,
        }));
        forward('always-on:turn-event', payload({
            type: 'agent_status',
            event: 'subagent_started',
            detail: { subagentId: 'child-2', subagentType: 'general-purpose' },
        }));

        expect(forwarded.filter(({ frame }) => frame.kind === 'session_created')).toHaveLength(2);
        expect(forwarded.find(({ frame }) => frame.kind === 'error')?.frame).toMatchObject({
            code: 'agent_aborted',
            terminal: true,
        });
    });

    it('treats normal completion and top-level errors as terminal', () => {
        expect(isTerminalAlwaysOnTurnEvent({ type: 'turn_completed' })).toBe(true);
        expect(isTerminalAlwaysOnTurnEvent({ type: 'error', code: 'agent_aborted' })).toBe(true);
        expect(isTerminalAlwaysOnTurnEvent({ type: 'error', code: 'session_busy' })).toBe(false);
        expect(isTerminalAlwaysOnTurnEvent({ type: 'assistant_text_delta', text: 'still running' })).toBe(false);
    });

    it('marks gateway error frames as confirmed terminal', () => {
        expect(gatewayEventToFrames({
            type: 'error',
            code: 'gateway_disconnected',
            message: 'The gateway connection was lost.',
        }, 'cron:task-1', 'pilotdeck')[0]).toMatchObject({
            kind: 'error',
            terminal: true,
        });
    });

    it('marks session-busy errors as non-terminal because the previous turn is still running', () => {
        expect(gatewayEventToFrames({
            type: 'agent_status',
            event: 'session_busy',
            detail: {
                message: 'The session already has an active turn.',
                code: 'session_busy',
                visible: true,
            },
        }, 'cron:task-1', 'pilotdeck')[0]).toMatchObject({
            kind: 'error',
            code: 'session_busy',
            terminal: false,
        });

        expect(gatewayEventToFrames({
            type: 'error',
            code: 'session_busy',
            message: 'The session already has an active turn.',
        }, 'cron:task-1', 'pilotdeck')[0]).toMatchObject({
            kind: 'error',
            code: 'session_busy',
            terminal: false,
        });
    });
});
