// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GeneratedImageCard from './GeneratedImageCard';
import { UnifiedToolCall } from './UnifiedToolCall';
import type { ChatMessage } from '../types/types';
import { isProcessMessage, buildRenderableMessageItems, foldCompletedTurns } from '../../chat-v2/processGrouping';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) })) }));
vi.mock('../view/subcomponents/ImageLightbox', () => ({ default: () => null }));
const message = { id: 'draw', toolId: 'draw', type: 'tool', isToolUse: true, toolName: 'generate_image', timestamp: new Date(), content: '' } as ChatMessage;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps drawing in the main conversation and replaces the same animated surface when the image loads', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
  expect(isProcessMessage(message)).toBe(true);
  const { container, rerender } = render(<GeneratedImageCard message={message} running />);
  const surface = container.querySelector('.generated-image-surface');
  expect(surface?.getAttribute('aria-busy')).toBe('true');
  rerender(<GeneratedImageCard running message={{ ...message, toolResult: { content: 'done', toolUseResult: { imageGeneration: { imageId: 'image-1', sessionId: 'session-1', width: 24, height: 16, mimeType: 'image/png', purpose: 'deliverable', savedTo: '/project/assets/image.png' } } } }} />);
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:test'));
  expect(container.querySelector('.generated-image-surface')).toBe(surface);
  fireEvent.load(screen.getByRole('img'));
  expect(surface?.getAttribute('aria-busy')).toBe('false');
  expect(screen.getByRole('link').getAttribute('download')).toBe('image-image-1.png');
  expect(container.textContent).not.toContain('/project/assets/image.png');
});

it('stops animating on historical unfinished calls', () => {
  const { container } = render(<GeneratedImageCard message={message} running={false} />);
  expect(container.querySelector('.is-waiting')).toBeNull();
  expect(screen.getAllByText('imageGeneration.interrupted').length).toBeGreaterThan(0);
});

it('keeps a successful result without image metadata as an inspectable tool instead of a drawing placeholder', () => {
  const { container } = render(<UnifiedToolCall message={{ ...message, toolResult: { content: 'Image attached' } }} createDiff={() => []} running />);
  expect(container.querySelector('.generated-image-card')).toBeNull();
  fireEvent.click(container.querySelector('.tool-call button[aria-expanded]')!);
  expect(screen.getByText('Image attached')).toBeTruthy();
  expect(container.querySelector('.generated-image-card')).toBeNull();
});

it('shows intermediate images only after the user opens the ordinary tool details', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:asset'); URL.revokeObjectURL = vi.fn();
  const asset = { ...message, toolInput: { purpose: 'intermediate' }, toolResult: { content: 'internal image metadata', toolUseResult: { imageGeneration: { imageId: 'asset-1', sessionId: 'session-1', width: 24, height: 16, mimeType: 'image/png', purpose: 'intermediate', savedTo: '/project/assets/hero.png' } } } };
  const { container } = render(<UnifiedToolCall message={asset} createDiff={() => []} />);
  expect(container.querySelector('.generated-image-card')).toBeNull();
  fireEvent.click(container.querySelector('.tool-call button[aria-expanded]')!);
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:asset'));
  fireEvent.load(screen.getByRole('img'));
  expect(container.textContent).not.toContain('/project/assets/hero.png');
  expect(container.textContent).not.toContain('internal image metadata');
});

it('keeps the image outside and the tool record inside the collapsed trace', () => {
  const messages: ChatMessage[] = [
    { ...message, id: 'user', type: 'user', isToolUse: false, content: 'draw' },
    { ...message, id: 'shell', toolId: 'shell', toolName: 'Bash', toolResult: { content: 'ok' } },
    { ...message, toolResult: { content: 'image attached', toolUseResult: { imageGeneration: { imageId: 'image', sessionId: 'session' } } } },
    { ...message, id: 'answer', type: 'assistant', isToolUse: false, content: 'done' },
  ];
  const items = foldCompletedTurns(messages, buildRenderableMessageItems(messages), false);
  expect(items.filter(item => item.mediaArtifact)).toHaveLength(1);
  const details = items.flatMap(item => item.turnTrace?.items ?? []).flatMap(item => [
    item.message, ...[...item.beforeProcessAttachments, ...item.afterProcessAttachments].flatMap(attachment => attachment.processDetailMessages),
  ]);
  expect(details.some(message => message.toolName === 'generate_image')).toBe(true);
});
