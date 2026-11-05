import { expect, it } from 'vitest';
import type { ChatMessage } from '../types/types';
import { buildRenderableMessageItems, groupProcessIntervals, getLiveProcessDetailMessages, isProcessMessage } from '../../chat-v2/processGrouping';
import { imagePurpose, isImageDeliverable } from './imagePresentation';

const base = { id: 'draw', type: 'tool', isToolUse: true, toolName: 'generate_image', timestamp: new Date(), content: '' } as ChatMessage;

it('uses explicit intent independently of project storage, including metadata-only history', () => {
  expect(imagePurpose({ ...base, toolInput: JSON.stringify({ purpose: 'deliverable', output_path: 'logo.png' }) })).toBe('deliverable');
  expect(imagePurpose({ ...base, toolInput: { purpose: 'intermediate' } })).toBe('intermediate');
  expect(imagePurpose({ ...base, toolResult: { content: '', toolUseResult: { imageGeneration: { purpose: 'intermediate' } } } })).toBe('intermediate');
});

it('keeps legacy saved assets in the process and legacy casual drawings visible', () => {
  expect(imagePurpose({ ...base, toolInput: '{"output_path":"assets/hero.png"}' })).toBe('intermediate');
  expect(imagePurpose({ ...base, toolResult: { content: '', toolUseResult: { imageGeneration: { savedTo: '/project/assets/hero.png' } } } })).toBe('intermediate');
  expect(imagePurpose(base)).toBe('deliverable');
});

it('retains a running deliverable tool record independently of its pending image surface', () => {
  const call: ChatMessage = { ...base, toolInput: { purpose: 'deliverable' } };
  const messages: ChatMessage[] = [{ ...base, id: 'user', type: 'user', isToolUse: false, content: 'Draw' }, call];
  const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
  expect(items.filter(item => item.mediaArtifact && item.mediaExpanded)).toHaveLength(1);
  expect(getLiveProcessDetailMessages(messages)).toContain(call);
  expect(items.find(item => item.mediaArtifact)?.message.renderKey).toBe('media-artifact-draw');
});

it('falls back to the ordinary tool record when a completed image result has no attachment identity', () => {
  const completed = { ...base, toolInput: { purpose: 'deliverable' }, toolResult: { content: 'Image attached' } };
  expect(isImageDeliverable(completed)).toBe(false);
  expect(buildRenderableMessageItems([completed]).some(item => item.mediaArtifact && item.mediaExpanded)).toBe(false);
});

it.each(['generate_image', 'edit_image'])('keeps only successful deliverables outside the completed %s trace', toolName => {
  const asset: ChatMessage = { ...base, id: 'asset', toolName, toolInput: { purpose: 'intermediate' }, toolResult: { content: 'asset' } };
  const failed: ChatMessage = { ...base, id: 'failed', toolName, toolInput: { purpose: 'deliverable' }, toolResult: { content: 'timeout', isError: true } };
  const delivered: ChatMessage = { ...base, id: 'delivered', toolName, toolInput: { purpose: 'deliverable', output_path: 'logo.png' }, toolResult: { content: 'image', toolUseResult: { imageGeneration: { imageId: 'image', sessionId: 'session' } } } };
  const messages: ChatMessage[] = [
    { ...base, id: 'user', type: 'user', isToolUse: false, content: 'Build a site and show its logo separately' },
    asset, failed, delivered,
    { ...base, id: 'answer', type: 'assistant', isToolUse: false, content: 'Done' },
  ];
  expect(isProcessMessage(asset)).toBe(true);
  expect(isProcessMessage(failed)).toBe(true);
  expect(isImageDeliverable(failed)).toBe(false);
  expect(isProcessMessage(delivered)).toBe(true);
  const items = groupProcessIntervals(messages, buildRenderableMessageItems(messages), false);
  expect(items.filter(item => item.message.isToolUse && (!item.mediaArtifact || item.mediaExpanded)).map(item => item.message.id)).toEqual(['delivered']);
  expect(items.filter(item => item.mediaArtifact && item.mediaExpanded)).toHaveLength(1);
  const trace = items.find(item => item.turnTrace)?.turnTrace?.items ?? [];
  const details = trace.flatMap(item => [item.message, ...[...item.beforeProcessAttachments, ...item.afterProcessAttachments].flatMap(attachment => attachment.processDetailMessages)]);
  expect(details.map(message => message.id)).toEqual(expect.arrayContaining(['asset', 'failed', 'delivered']));
});
