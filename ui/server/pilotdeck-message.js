/**
 * PilotDeck-flavored chat message helper.
 *
 * Replaces the legacy `providers/types.js` module. The shape on the wire
 * is unchanged (frontend reads `kind`, `sessionId`, `provider`, `timestamp`,
 * etc.) so we keep the public name `createNormalizedMessage`. Existing
 * imports point at this file via `./pilotdeck-message.js`.
 *
 * Allowed `kind` values mirror what the chat UI's reducer recognises:
 *   text | tool_use | tool_result | thinking | stream_delta | stream_end
 *   error | complete | status | permission_request | permission_cancelled
 *   session_created | interactive_prompt | task_notification | interrupted
 */

import crypto from 'node:crypto';

export function generateMessageId(prefix = 'msg') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function createNormalizedMessage(fields) {
  return {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider || 'pilotdeck',
  };
}

export function createOptimisticUserFrames({
  sessionId,
  provider = 'pilotdeck',
  userVisibleInput,
  options = {},
  timestamp = new Date().toISOString(),
}) {
  const runId = typeof options.runId === 'string'
    ? options.runId.trim() || undefined
    : undefined;
  const images = Array.isArray(options.images)
    ? options.images
      .map((image) => typeof image === 'string' ? image : image?.data)
      .filter((image) => typeof image === 'string')
    : [];

  return [
    createNormalizedMessage({
      id: `local_ws_user_${crypto.randomUUID()}`,
      sessionId,
      provider,
      kind: 'text',
      role: 'user',
      content: userVisibleInput,
      ...(runId ? { runId } : {}),
      ...(Array.isArray(options.attachments) && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
      ...(images.length > 0 ? { images } : {}),
      timestamp,
    }),
    createNormalizedMessage({
      id: `local_ws_status_${crypto.randomUUID()}`,
      sessionId,
      provider,
      kind: 'status',
      text: 'Processing',
      canInterrupt: true,
      ...(runId ? { runId } : {}),
      timestamp,
    }),
  ];
}
