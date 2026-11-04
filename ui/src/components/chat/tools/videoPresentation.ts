import type { ChatMessage } from '../types/types';
import { objectValue } from './toolPresentation';

export function videoAttachment(message: ChatMessage) {
  const video = objectValue(objectValue(message.toolResult?.toolUseResult).videoGeneration);
  return typeof video.videoId === 'string' && typeof video.sessionId === 'string' ? video : undefined;
}
export function isVideoDeliverable(message: ChatMessage): boolean {
  const video = videoAttachment(message);
  const purpose = video?.purpose ?? objectValue(message.toolInput).purpose;
  return Boolean(message.isToolUse && message.toolName === 'generate_video' && !message.toolResult?.isError
    && purpose === 'deliverable' && (!message.toolResult || video));
}
