import type { ChatMessage } from '../types/types';
import { objectValue } from './toolPresentation';

export type VideoJobView = { id: string; sessionId: string; toolCallId: string; purpose: string;
  state: 'tracking' | 'reconnecting' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'; reason?: string;
  video?: { videoId: string; sessionId: string; purpose: string }; exportError?: boolean };
export function videoJob(message: ChatMessage): VideoJobView | undefined {
  const value = objectValue(message.videoJob);
  return typeof value.id === 'string' && typeof value.state === 'string' ? value as VideoJobView : undefined;
}
export function videoAttachment(message: ChatMessage) {
  if (videoJob(message)?.video) return videoJob(message)!.video;
  const video = objectValue(objectValue(message.toolResult?.toolUseResult).videoGeneration);
  return typeof video.videoId === 'string' && typeof video.sessionId === 'string' ? video : undefined;
}
export function isVideoDeliverable(message: ChatMessage): boolean {
  const video = videoAttachment(message);
  const purpose = video?.purpose ?? objectValue(message.toolInput).purpose;
  const job = videoJob(message);
  if (job && ['failed', 'cancelled'].includes(job.state)) return false;
  return Boolean(message.isToolUse && message.toolName === 'generate_video' && (job || !message.toolResult?.isError)
    && purpose === 'deliverable' && (!message.toolResult || video || job));
}
