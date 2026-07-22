/**
 * Unified session messages endpoint (PilotDeck-only).
 *
 * GET /api/sessions/:sessionId/messages?projectName=&projectPath=&limit=&offset=
 *
 * Reads transcripts through the gateway's `readSessionMessages` RPC.
 * Previously this route imported `readWebSessionMessages` directly from
 * `dist/src/web/server/` — that coupled `ui/server/` to compiled
 * artifacts and meant `src/` edits were silently invisible until a
 * `npm run build`. Going through the gateway WebSocket means the
 * standalone `pilotdeck server` process owns the read path and we pick
 * up its in-flight session writes automatically.
 *
 * @module routes/messages
 */

import express from 'express';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { createNormalizedMessage } from '../pilotdeck-message.js';

const router = express.Router();
const REPO_ROOT = process.cwd();

function isSearchToolName(name) {
  const normalized = String(name || '').toLowerCase();
  return normalized === 'grep' || normalized === 'glob';
}

router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const projectPath = String(req.query.projectPath || req.query.projectName || REPO_ROOT);
    const limitParam = req.query.limit;
    const limit = limitParam !== undefined && limitParam !== null && limitParam !== ''
      ? parseInt(limitParam, 10)
      : null;
    const offset = parseInt(req.query.offset || '0', 10);

    const gateway = await getPilotDeckGateway();
    const result = await gateway.readSessionMessages({
      sessionKey: sessionId,
      projectKey: projectPath,
      limit: limit ?? undefined,
      cursor: offset > 0 ? String(offset) : undefined,
      ...(typeof req.query.sessionKind === 'string' && req.query.sessionKind
        ? { sessionKind: req.query.sessionKind }
        : {}),
      ...(typeof req.query.parentSessionId === 'string' && req.query.parentSessionId
        ? { parentSessionId: req.query.parentSessionId }
        : {}),
      ...(typeof req.query.relativeTranscriptPath === 'string' && req.query.relativeTranscriptPath
        ? { relativeTranscriptPath: req.query.relativeTranscriptPath }
        : {}),
    });

    const messages = result.messages.map((message) => mapWebMessageToNormalized(message, sessionId));
    const totalKnown = typeof result.total === 'number' ? result.total : messages.length + offset;
    const hasMore = result.nextCursor !== undefined && result.nextCursor !== null;

    return res.json({
      messages,
      total: totalKnown,
      hasMore,
      offset,
      limit,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    });
  } catch (error) {
    console.error('[messages] read_session_messages failed:', error);
    return res.json({ messages: [], total: 0, hasMore: false, offset: 0, limit: null });
  }
});

router.post('/:sessionId/fork', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const projectPath = String(req.body?.projectPath || req.body?.projectName || req.query.projectPath || REPO_ROOT);
    const fromEntryId = String(req.body?.fromEntryId || '');
    if (!fromEntryId) {
      return res.status(400).json({ error: 'fromEntryId is required' });
    }

    const gateway = await getPilotDeckGateway();
    const result = await gateway.forkSession({
      sessionKey: sessionId,
      projectKey: projectPath,
      fromEntryId,
    });

    return res.json({
      newSessionId: result.newSessionKey,
      prefillText: result.prefillText,
      carriedMessageCount: result.carriedMessageCount,
      ...(result.mode ? { mode: result.mode } : {}),
    });
  } catch (error) {
    console.error('[messages] fork_session failed:', error);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code.startsWith('fork_')) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Fork failed',
        code,
      });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Fork failed',
    });
  }
});

router.get('/:sessionId/subagent/:subagentId/messages', async (req, res) => {
  try {
    const { sessionId, subagentId } = req.params;
    const projectPath = String(req.query.projectPath || req.query.projectName || REPO_ROOT);

    const gateway = await getPilotDeckGateway();
    const result = await gateway.readSubagentMessages({
      sessionKey: sessionId,
      subagentId,
      projectKey: projectPath,
      ...(typeof req.query.sessionKind === 'string' && req.query.sessionKind
        ? { sessionKind: req.query.sessionKind }
        : {}),
      ...(typeof req.query.parentSessionId === 'string' && req.query.parentSessionId
        ? { parentSessionId: req.query.parentSessionId }
        : {}),
      ...(typeof req.query.relativeTranscriptPath === 'string' && req.query.relativeTranscriptPath
        ? { relativeTranscriptPath: req.query.relativeTranscriptPath }
        : {}),
    });

    const messages = result.messages.map((message) =>
      mapWebMessageToNormalized(message, `${sessionId}::sub::${subagentId}`)
    );

    return res.json({
      messages,
      total: result.total,
      hasMore: false,
    });
  } catch (error) {
    console.error('[messages] read_subagent_messages failed:', error);
    return res.json({ messages: [], total: 0, hasMore: false });
  }
});

function mapWebMessageToNormalized(message, sessionId) {
  const base = {
    id: message.id,
    sessionId,
    timestamp: message.createdAt,
    provider: message.provider || 'pilotdeck',
    ...(message.entryId ? { entryId: message.entryId } : {}),
  };
  switch (message.kind) {
    case 'text': {
      const payload = message.payload && typeof message.payload === 'object'
        ? message.payload
        : {};
      return createNormalizedMessage({
        ...base,
        kind: 'text',
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.text || '',
        ...(Array.isArray(message.images) && message.images.length > 0
          ? { images: message.images.map((image) => image?.data).filter(Boolean) }
          : {}),
        ...(Array.isArray(payload.attachments) && payload.attachments.length > 0
          ? { attachments: payload.attachments }
          : {}),
        ...(payload.forkUnsupportedContent === true
          ? {
              forkUnsupportedContent: true,
              forkUnsupportedReason: typeof payload.forkUnsupportedReason === 'string'
                ? payload.forkUnsupportedReason
                : undefined,
            }
          : {}),
      });
    }
    case 'thinking':
      return createNormalizedMessage({ ...base, kind: 'thinking', content: message.text || '' });
    case 'file_artifacts':
      return createNormalizedMessage({
        ...base,
        kind: 'file_artifacts',
        artifacts: Array.isArray(message.artifacts) ? message.artifacts : [],
      });
    case 'tool_use':
      return createNormalizedMessage({
        ...base,
        kind: 'tool_use',
        toolName: message.toolName,
        toolInput: message.payload,
        toolId: message.toolCallId,
        ...(message.subagentId ? { subagentId: message.subagentId } : {}),
      });
    case 'tool_result': {
      const planPayload = message.payload && typeof message.payload === 'object'
          ? message.payload
          : {};
      const searchPayload = isSearchToolName(message.toolName) && message.payload && typeof message.payload === 'object'
          ? message.payload
          : null;
      return createNormalizedMessage({
        ...base,
        kind: 'tool_result',
        toolId: message.toolCallId,
        content: message.text || '',
        isError: message.ok === false,
        ...(message.resultPath ? { resultPath: message.resultPath } : {}),
        ...(message.errorCode ? { errorCode: message.errorCode } : {}),
        // Inline tool-result images (e.g. read_file on a PNG). The web
        // server already wraps the bare base64 from canonical messages as
        // data URLs in `toWebMessageImage`, so just pass them through.
        ...(Array.isArray(message.images) && message.images.length > 0
          ? {
              toolResultImages: message.images
                .filter((image) => image && typeof image.data === 'string')
                .map((image) => ({ data: image.data, mimeType: image.mimeType })),
            }
          : {}),
        ...(planPayload.planFilePath ? {
            planFilePath: planPayload.planFilePath,
            planTitle: planPayload.planTitle,
            planSummary: planPayload.planSummary,
        } : {}),
        ...(searchPayload ? { toolUseResult: searchPayload } : {}),
      });
    }
    case 'permission_request':
      return createNormalizedMessage({
        ...base,
        kind: 'permission_request',
        requestId: message.requestId,
        toolName: message.toolName,
        input: message.payload,
      });
    case 'elicitation_request':
      return createNormalizedMessage({
        ...base,
        kind: 'interactive_prompt',
        requestId: message.requestId,
        content: '',
      });
    case 'structured_output':
      return createNormalizedMessage({
        ...base,
        kind: 'status',
        text: 'structured',
        payload: message.payload,
      });
    case 'status':
      return createNormalizedMessage({
        ...base,
        kind: 'status',
        text: message.text || '',
        ...(message.contentI18n ? { contentI18n: message.contentI18n } : {}),
        ...(message.userHintI18n ? { userHintI18n: message.userHintI18n } : {}),
      });
    case 'complete':
      return createNormalizedMessage({ ...base, kind: 'complete' });
    case 'error':
      return createNormalizedMessage({
        ...base,
        kind: 'error',
        content: message.text || '',
        ...(message.payload?.detail?.userHint ? { userHint: message.payload.detail.userHint } : {}),
        ...(message.contentI18n ? { contentI18n: message.contentI18n } : {}),
        ...(message.userHintI18n ? { userHintI18n: message.userHintI18n } : {}),
      });
    case 'interrupted':
      return createNormalizedMessage({ ...base, kind: 'interrupted', content: message.text || '' });
    case 'compact_boundary': {
      const payload = message.payload || {};
      return createNormalizedMessage({
        ...base,
        kind: 'compact_boundary',
        trigger: payload.trigger || 'auto',
        preTokens: payload.preTokens,
        compactLevel: payload.level,
        compactStage: payload.stage,
        compactStageLabel: payload.stageLabel || payload.stage,
        compactMetadata: payload,
      });
    }
    default:
      return createNormalizedMessage({ ...base, kind: 'status', text: message.kind });
  }
}

export default router;
