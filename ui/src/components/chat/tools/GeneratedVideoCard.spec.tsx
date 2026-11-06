// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildRenderableMessageItems, groupProcessIntervals } from '../utils/processGrouping';
import type { ChatMessage } from '../types/types';
import { isBinaryFile, isVideoFile } from '../../code-editor/utils/binaryFile';
import { attachmentPreviewKind } from '../utils/attachmentPreviewKind';
import { isVideoDeliverable } from './videoPresentation';
import { UnifiedToolCall } from './UnifiedToolCall';
import GeneratedVideoCard from './GeneratedVideoCard';

const recoveryApi = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: recoveryApi.fetch, appendAuthToken: (url: string) => url + (url.includes('?') ? '&' : '?') + 'token=fixture' }));
const pending = { id: 'video', toolId: 'video', type: 'tool', isToolUse: true, toolName: 'generate_video', toolInput: { purpose: 'deliverable' }, content: '' } as ChatMessage;
const complete: ChatMessage = { ...pending, toolResult: { content: 'Stored at /private/video.mp4', toolUseResult: { videoGeneration: { videoId: 'video-id', sessionId: 'session-id', purpose: 'deliverable', savedTo: '/project/movie.mp4' } } } };
afterEach(cleanup);
it('replaces the generating placeholder with a direct streaming player and hover download without a path footer', () => {
  const { container, rerender } = render(<GeneratedVideoCard message={pending} running />);
  expect(container.querySelector('.is-waiting')).not.toBeNull();
  rerender(<GeneratedVideoCard message={complete} running={false} />);
  const video = container.querySelector('video')!;
  expect(video.src).toContain('/api/video-generation/session-id/video-id?token=fixture');
  expect(video.hasAttribute('controls')).toBe(true); expect(video.preload).toBe('metadata');
  expect(screen.getByRole('link').getAttribute('download')).toBe('video-video-id.mp4');
  expect(container.textContent).not.toContain('/project/'); expect(container.textContent).not.toContain('/private/');
  fireEvent.error(video); expect(screen.getByRole('status').textContent).toContain('videoGeneration.playbackUnavailable');
});
it('keeps final video and its original call independently in the completed trace while folding intermediate and failed calls', () => {
  const asset = { ...complete, id: 'asset', toolInput: { purpose: 'intermediate' }, toolResult: { content: 'asset', toolUseResult: { videoGeneration: { videoId: 'asset-id', sessionId: 'session-id', purpose: 'intermediate' } } } };
  const failed = { ...pending, id: 'failed', toolResult: { content: 'error', isError: true } };
  const messages: ChatMessage[] = [{ id: 'user', type: 'user', timestamp: new Date(), content: 'Create a site and show a video' }, asset, failed, complete, { id: 'answer', type: 'assistant', timestamp: new Date(), content: 'Done' }];
  const items = groupProcessIntervals(messages, buildRenderableMessageItems(messages), false);
  expect(items.filter(i => i.mediaArtifact && i.mediaExpanded)).toHaveLength(1);
  const details = items.find(i => i.turnTrace)?.turnTrace?.items.flatMap(i => [i.message, ...[...i.beforeProcessAttachments, ...i.afterProcessAttachments].flatMap(a => a.processDetailMessages)]) ?? [];
  expect(details.map(m => m.id)).toEqual(expect.arrayContaining(['video', 'asset', 'failed']));
  expect(isVideoDeliverable(failed)).toBe(false);
  expect(buildRenderableMessageItems([pending], { isAssistantWorking: true }).some(i => i.mediaArtifact && i.mediaExpanded)).toBe(true);
});
it('shows intermediate video inside expanded tool details and no giant failed card', () => {
  const { container, rerender } = render(<UnifiedToolCall message={{ ...complete, toolInput: { purpose: 'intermediate' }, toolResult: { ...complete.toolResult!, toolUseResult: { videoGeneration: { videoId: 'id', sessionId: 'session', purpose: 'intermediate' } } } }} createDiff={() => []} running={false} defaultOpen />);
  expect(container.querySelector('video')).not.toBeNull();
  rerender(<GeneratedVideoCard message={{ ...pending, toolResult: { content: 'error', isError: true } }} running={false} />);
  expect(container.querySelector('video')).toBeNull(); expect(container.textContent).toBe('');
});
it.each(['MP4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'])('treats %s as a video and never an editable text document', extension => {
  expect(isVideoFile('clip.' + extension)).toBe(true); expect(isBinaryFile('clip.' + extension)).toBe(true);
  expect(attachmentPreviewKind({ name: 'clip.' + extension, type: '' })).toBe('video');
});

it('folds interrupted or historical pending video calls without leaving a large placeholder', () => {
  expect(buildRenderableMessageItems([pending], { isAssistantWorking: false }).some(i => i.mediaArtifact && i.mediaExpanded)).toBe(false);
  const later = { id: 'next-turn', timestamp: new Date(), type: 'user', content: 'Continue' } as ChatMessage;
  expect(buildRenderableMessageItems([pending, later], { isAssistantWorking: true }).some(i => i.mediaArtifact && i.mediaExpanded)).toBe(false);
});

it('keeps a paused known job in front after the Agent turn ends and restores its player without losing the call record', () => {
  const saved = { ...pending, toolResult: { isError: true, content: 'Wait stopped' }, videoJob: { id: 'job', sessionId: 'session', toolCallId: 'video', state: 'paused', purpose: 'deliverable', reason: 'timeout' } } as ChatMessage;
  expect(buildRenderableMessageItems([saved], { isAssistantWorking: false }).filter(i => i.mediaArtifact && i.mediaExpanded)).toHaveLength(1);
  const { container, rerender } = render(<GeneratedVideoCard message={saved} running={false} />);
  expect(screen.getByRole('button').textContent).toBe('videoGeneration.resume');
  expect(container.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
  rerender(<GeneratedVideoCard message={{ ...saved, videoJob: { ...(saved.videoJob as object), state: 'reconnecting' } }} running={false} />);
  expect(screen.getByRole('status').textContent).toContain('videoGeneration.reconnecting');
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<GeneratedVideoCard message={{ ...saved, videoJob: { ...(saved.videoJob as object), state: 'completed', video: { videoId: 'recovered', sessionId: 'session', purpose: 'deliverable' } } }} running={false} />);
  expect(container.querySelector('video')?.src).toContain('/session/recovered');
});

it('resumes the saved host task from its card without a generation request', async () => {
  recoveryApi.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'job', sessionId: 'session', state: 'tracking', purpose: 'deliverable' }) });
  render(<GeneratedVideoCard message={{ ...pending, videoJob: { id: 'job', sessionId: 'session', state: 'paused', purpose: 'deliverable' } }} running={false} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  expect(recoveryApi.fetch).toHaveBeenCalledWith('/api/video-generation/jobs/session/job/resume', expect.objectContaining({ method: 'POST' }));
  expect(screen.getByRole('status').textContent).toContain('videoGeneration.generating');
});
it('keeps original video tool details when an interrupted turn has no assistant prose host', () => {
  const interrupted = { ...pending, videoJob: { id: 'job', state: 'paused', sessionId: 'session', purpose: 'deliverable' } } as ChatMessage;
  const items = buildRenderableMessageItems([interrupted], { isAssistantWorking: false });
  const details = items.flatMap(i => [...i.beforeProcessAttachments, ...i.afterProcessAttachments].flatMap(a => a.processDetailMessages));
  expect(details.some(m => m.toolId === 'video')).toBe(true);
  expect(items.filter(i => i.mediaArtifact && i.mediaExpanded)).toHaveLength(1);
});
