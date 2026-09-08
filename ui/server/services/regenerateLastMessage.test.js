import { describe, expect, it, vi } from 'vitest';

import { regenerateLastMessageTransaction } from './regenerateLastMessage.js';

function requestData() {
    return {
        command: 'corrected request',
        options: {
            runId: 'turn-replacement',
            userVisibleInput: 'corrected request',
        },
    };
}

describe('regenerateLastMessageTransaction', () => {
    it('uses display attachments for the replacement bubble', async () => {
        const streamFrames = [];
        const data = requestData();
        data.options.attachments = [{ name: 'workspace.txt' }];
        data.options.displayAttachments = [{ name: 'upload.pdf', uploadId: 'upload-1' }];
        await regenerateLastMessageTransaction({
            data,
            sessionId: 'web:s_test',
            requestId: 'request-display',
            expectedTurnId: 'turn-old',
            provider: 'pilotdeck',
            writer: { send: () => undefined },
            streamWriter: { send: (frame) => streamFrames.push(frame) },
            replaceLastTurn: vi.fn(async () => ({ replacedTurnId: 'turn-old', transactionId: 'tx' })),
            finalizeLastTurnReplacement: vi.fn(),
            runChat: vi.fn(async (_command, _options, _writer, _provider, hooks) => {
                hooks.onInputAccepted();
                return { inputAccepted: true };
            }),
        });
        expect(streamFrames[0]).toMatchObject({
            type: 'session-turn-replaced',
            attachments: [{ name: 'upload.pdf', uploadId: 'upload-1' }],
        });
    });

    it('reports success and releases buffered frames only after input_accepted', async () => {
        const resultFrames = [];
        const streamFrames = [];
        const finalize = vi.fn();

        const result = await regenerateLastMessageTransaction({
            data: requestData(),
            sessionId: 'web:s_test',
            requestId: 'request-1',
            expectedTurnId: 'turn-old',
            provider: 'pilotdeck',
            writer: { send: (frame) => resultFrames.push(frame) },
            streamWriter: { send: (frame) => streamFrames.push(frame) },
            replaceLastTurn: vi.fn(async () => ({
                replacedTurnId: 'turn-old',
                transactionId: 'transaction-1',
            })),
            finalizeLastTurnReplacement: finalize,
            runChat: vi.fn(async (_command, _options, replacementWriter, _provider, hooks) => {
                replacementWriter.send({ type: 'status-before-acceptance' });
                expect(streamFrames).toEqual([]);
                await hooks.onInputAccepted();
                replacementWriter.send({ type: 'assistant-after-acceptance' });
                return { inputAccepted: true };
            }),
        });

        expect(result).toEqual({ success: true, inputAccepted: true });
        expect(finalize).not.toHaveBeenCalled();
        expect(resultFrames).toEqual([expect.objectContaining({
            type: 'regenerate-last-message-result',
            success: true,
        })]);
        expect(streamFrames.map((frame) => frame.type)).toEqual([
            'session-turn-replaced',
            'status-before-acceptance',
            'assistant-after-acceptance',
        ]);
    });

    it('rolls back and suppresses buffered turn frames when input is not accepted', async () => {
        const resultFrames = [];
        const streamFrames = [];
        const finalize = vi.fn(async () => undefined);

        const result = await regenerateLastMessageTransaction({
            data: requestData(),
            sessionId: 'web:s_test',
            requestId: 'request-2',
            expectedTurnId: 'turn-old',
            provider: 'pilotdeck',
            writer: { send: (frame) => resultFrames.push(frame) },
            streamWriter: { send: (frame) => streamFrames.push(frame) },
            replaceLastTurn: vi.fn(async () => ({
                replacedTurnId: 'turn-old',
                transactionId: 'transaction-2',
            })),
            finalizeLastTurnReplacement: finalize,
            runChat: vi.fn(async (_command, _options, replacementWriter) => {
                replacementWriter.send({ type: 'gateway-preflight-error' });
                return { inputAccepted: false };
            }),
        });

        expect(result).toEqual({ success: false, inputAccepted: false, rolledBack: true });
        expect(finalize).toHaveBeenCalledOnce();
        expect(finalize).toHaveBeenCalledWith(
            'web:s_test',
            'transaction-2',
            'rollback',
            requestData().options,
        );
        expect(streamFrames).toEqual([]);
        expect(resultFrames).toEqual([expect.objectContaining({
            type: 'regenerate-last-message-result',
            success: false,
            error: expect.stringContaining('original turn was restored'),
        })]);
    });
});
