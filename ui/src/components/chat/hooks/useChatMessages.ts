/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';
import { parseUserAttachmentNote } from '../utils/attachmentNotes';

function convertNormalizedMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  for (const msg of messages) {
    switch (msg.kind) {
      case 'text': {
        const parsedUserContent = msg.role === 'user'
          ? parseUserAttachmentNote(msg.content || '')
          : { content: msg.content || '', attachments: [] };
        const content = parsedUserContent.content;
        const storedAttachments = Array.isArray(msg.attachments)
          ? msg.attachments.filter((attachment) => attachment && typeof attachment.name === 'string')
          : undefined;
        const userAttachments = [
          ...(storedAttachments || []),
          ...parsedUserContent.attachments,
        ];

        if (msg.role === 'user') {
          // `NormalizedMessage.images` carries data URLs as strings (see
          // chatMessageToNormalized). MessageComponent renders these via
          // `message.images.[].data`, so reconstruct the ChatImage shape
          // here. Without this, optimistic user messages with attached
          // images flicker to "no images" on re-derivation.
          const userImages = Array.isArray(msg.images)
            ? msg.images
                .filter((d) => typeof d === 'string' && d.length > 0)
                .map((d) => ({ data: d, name: '' }))
            : undefined;
          if (!content.trim() && userAttachments.length === 0 && (!userImages || userImages.length === 0)) continue;
          converted.push({
            id: msg.id,
            type: 'user',
            content: unescapeWithMathProtection(decodeHtmlEntities(content)),
            timestamp: msg.timestamp,
            ...(userImages && userImages.length > 0 ? { images: userImages } : {}),
            ...(userAttachments.length > 0 ? { attachments: userAttachments } : {}),
          });
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        const normalizedToolName = String(msg.toolName || '').toLowerCase();
        const isSubagentContainer = normalizedToolName === 'task' || normalizedToolName === 'agent';

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }

        const toolResultImages = tr && Array.isArray((tr as any).toolResultImages)
          ? ((tr as any).toolResultImages as Array<{ data?: unknown; mimeType?: unknown; name?: unknown }>)
              .filter((image) => image && typeof image.data === 'string' && image.data.length > 0)
              .map((image) => ({
                data: image.data as string,
                name: typeof image.name === 'string' ? image.name : '',
                ...(typeof image.mimeType === 'string' ? { mimeType: image.mimeType } : {}),
              }))
          : undefined;
        const toolResult = tr
          ? {
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
              errorCode: (tr as any).errorCode,
              ...(toolResultImages && toolResultImages.length > 0 ? { images: toolResultImages } : {}),
              ...((tr as any).planFilePath ? {
                  planFilePath: (tr as any).planFilePath,
                  planTitle: (tr as any).planTitle,
                  planSummary: (tr as any).planSummary,
              } : {}),
            }
          : null;

        converted.push({
          id: msg.id,
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
                isFailed: Boolean(toolResult?.isError),
              }
            : undefined,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
          });
        }
        break;

      case 'error':
        converted.push({
          id: msg.id,
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
        });
        break;

      case 'task_notification':
        converted.push({
          id: msg.id,
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          taskId: msg.taskId || '',
          outputFile: msg.outputFile || '',
          taskResult: msg.taskResult || '',
        });
        break;

      case 'interrupted':
        converted.push({
          id: msg.id,
          type: 'system',
          content: msg.content || '[Request interrupted by user]',
          timestamp: msg.timestamp,
          isInterruptedNotice: true,
        });
        break;

      case 'compact_boundary':
        converted.push({
          id: msg.id,
          type: 'system',
          content: 'Context compacted',
          timestamp: msg.timestamp,
          isCompactBoundary: true,
          compactTrigger: msg.trigger,
          preTokens: msg.preTokens,
          compactLevel: msg.compactLevel,
          compactStage: msg.compactStage,
          compactStageLabel: msg.compactStageLabel,
        });
        break;

      case 'agent_activity':
        converted.push({
          id: msg.id,
          type: 'system',
          content: msg.title || '',
          timestamp: msg.timestamp,
          isAgentActivity: true,
          runId: msg.runId,
          activityId: msg.activityId,
          phase: msg.phase,
          state: msg.state,
          title: msg.title,
          detail: msg.detail,
          toolName: msg.toolName,
          toolId: msg.toolId,
          startedAt: msg.startedAt,
          endedAt: msg.endedAt,
          durationMs: msg.durationMs,
          severity: msg.severity,
        });
        break;

      case 'agent_activity_summary':
        converted.push({
          id: msg.id,
          type: 'system',
          content: msg.title || 'Process summary',
          timestamp: msg.timestamp,
          isAgentActivitySummary: true,
          runId: msg.runId,
          startedAt: msg.startedAt,
          endedAt: msg.endedAt,
          durationMs: msg.durationMs,
          state: msg.status,
          toolCallCount: msg.toolCallCount,
          toolErrorCount: msg.toolErrorCount,
          ragSearchCount: msg.ragSearchCount,
          editedFileCount: msg.editedFileCount,
          exploredFileCount: msg.exploredFileCount,
          commandCount: msg.commandCount,
          subagentCount: msg.subagentCount,
          compactCount: msg.compactCount,
          thinkingCount: msg.thinkingCount,
          otherToolCount: msg.otherToolCount,
          keySteps: msg.keySteps,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            id: msg.id,
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result':
        break;

      default:
        break;
    }
  }

  return converted;
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  return convertNormalizedMessages(messages);
}
