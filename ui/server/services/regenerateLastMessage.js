/**
 * Replace the latest transcript turn and acknowledge success only after the
 * edited accepted_input is durable. Frames emitted before that point stay
 * buffered; a pre-acceptance failure restores the original transcript.
 */
export async function regenerateLastMessageTransaction({
    data,
    sessionId,
    requestId,
    expectedTurnId,
    provider,
    writer,
    streamWriter,
    replaceLastTurn,
    finalizeLastTurnReplacement,
    runChat,
}) {
    let replacementResult = null;
    let replacementInputAccepted = false;
    let replacementRolledBack = false;
    const bufferedFrames = [];
    let releaseBufferedFrames = false;
    const replacementStreamWriter = {
        send: (frame) => {
            if (releaseBufferedFrames) {
                streamWriter.send(frame);
            } else {
                bufferedFrames.push(frame);
            }
        },
    };

    try {
        if (!sessionId || !expectedTurnId) {
            throw new Error('The last message could not be identified for editing.');
        }
        const replacementRunId = typeof data.options?.runId === 'string'
            ? data.options.runId.trim()
            : '';
        if (!replacementRunId) {
            throw new Error('The edited message could not be assigned a replacement turn.');
        }
        replacementResult = await replaceLastTurn(
            sessionId,
            expectedTurnId,
            data.options || {},
        );
        const acknowledgeAcceptedInput = () => {
            if (replacementInputAccepted) return;
            // The gateway commits the replacement backup before it emits
            // input_accepted, so this acknowledgement is durable.
            replacementInputAccepted = true;
            streamWriter.send({
                type: 'session-turn-replaced',
                requestId,
                sessionId,
                replacedTurnId: replacementResult.replacedTurnId,
                replacementRunId,
                provider,
                content: data.options?.userVisibleInput ?? data.command ?? '',
                images: data.options?.images || [],
                attachments: data.options?.displayAttachments || data.options?.attachments || [],
            });
            writer.send({
                type: 'regenerate-last-message-result',
                requestId,
                sessionId,
                success: true,
            });
            releaseBufferedFrames = true;
            for (const frame of bufferedFrames.splice(0)) {
                streamWriter.send(frame);
            }
        };
        const runResult = await runChat(
            data.command,
            data.options,
            replacementStreamWriter,
            provider,
            { onInputAccepted: acknowledgeAcceptedInput },
        );
        if (runResult?.inputAccepted) {
            acknowledgeAcceptedInput();
            return { success: true, inputAccepted: true };
        }

        await finalizeLastTurnReplacement(
            sessionId,
            replacementResult.transactionId,
            'rollback',
            data.options || {},
        );
        replacementRolledBack = true;
        throw new Error('The edited message was not persisted, so the original turn was restored.');
    } catch (error) {
        if (replacementResult && !replacementInputAccepted && !replacementRolledBack) {
            try {
                await finalizeLastTurnReplacement(
                    sessionId,
                    replacementResult.transactionId,
                    'rollback',
                    data.options || {},
                );
                replacementRolledBack = true;
            } catch (rollbackError) {
                console.error('[regenerate-last-message] failed to restore original turn:', rollbackError);
            }
        }
        writer.send({
            type: 'regenerate-last-message-result',
            requestId,
            sessionId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
        return { success: false, inputAccepted: false, rolledBack: replacementRolledBack };
    }
}
