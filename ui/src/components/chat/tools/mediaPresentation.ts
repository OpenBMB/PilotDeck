import type { ChatMessage } from '../types/types';
import { isDrawingTool, isImageDeliverable } from './imagePresentation';
import { isVideoDeliverable, videoJob } from './videoPresentation';

export function isMediaGeneration(message: ChatMessage): boolean {
  return Boolean(message.isToolUse && (isDrawingTool(message.toolName ?? '') || message.toolName === 'generate_video'));
}

/** Generation feedback is independent of whether the result is a final deliverable. */
export function isMediaSurfaceVisible(message: ChatMessage, inLiveTurn: boolean): boolean {
  if (!isMediaGeneration(message)) return false;
  if (message.toolName !== 'generate_video') {
    return message.toolResult ? isImageDeliverable(message) : inLiveTurn;
  }
  const job = videoJob(message);
  if (job && ['tracking', 'reconnecting', 'downloading', 'paused'].includes(job.state)) return true;
  if (!message.toolResult && !job && inLiveTurn) return true;
  return isVideoDeliverable(message) && Boolean(message.toolResult || job || inLiveTurn);
}
