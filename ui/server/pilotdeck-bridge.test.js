import { describe, expect, it } from 'vitest';

import {
    createAlwaysOnTurnEventForwarder,
    gatewayEventToFrames,
    getFallbackSessionActivity,
    isGatewayUnavailableError,
    isTerminalAlwaysOnTurnEvent,
    uiFilesToAttachments,
} from './pilotdeck-bridge.js';

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
