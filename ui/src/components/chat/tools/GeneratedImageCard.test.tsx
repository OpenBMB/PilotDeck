// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GeneratedImageCard from './GeneratedImageCard';
import type { ChatMessage } from '../types/types';
import { isProcessMessage, buildRenderableMessageItems, foldCompletedTurns } from '../../chat-v2/processGrouping';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) })) }));
vi.mock('../view/subcomponents/ImageLightbox', () => ({ default: () => null }));
const message = { id: 'draw', toolId: 'draw', type: 'tool', isToolUse: true, toolName: 'generate_image', timestamp: new Date(), content: '' } as ChatMessage;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps drawing in the main conversation and replaces the same animated surface when the image loads', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
  expect(isProcessMessage(message)).toBe(false);
  const { container, rerender } = render(<GeneratedImageCard message={message} running />);
  const surface = container.querySelector('.generated-image-surface');
  expect(surface?.getAttribute('aria-busy')).toBe('true');
  rerender(<GeneratedImageCard running message={{ ...message, toolResult: { content: 'done', toolUseResult: { imageGeneration: { imageId: 'image-1', sessionId: 'session-1', width: 24, height: 16, mimeType: 'image/png' } } } }} />);
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:test'));
  expect(container.querySelector('.generated-image-surface')).toBe(surface);
  fireEvent.load(screen.getByRole('img'));
  expect(surface?.getAttribute('aria-busy')).toBe('false');
  expect(screen.getByRole('link').getAttribute('download')).toBe('image-image-1.png');
});

it('stops animating on failure, cancellation, and historical unfinished calls', () => {
  const { container, rerender } = render(<GeneratedImageCard message={message} running={false} />);
  expect(container.querySelector('.is-waiting')).toBeNull();
  expect(screen.getAllByText('imageGeneration.interrupted').length).toBeGreaterThan(0);
  rerender(<GeneratedImageCard message={{ ...message, toolResult: { content: 'cancelled', isError: true } }} running={false} />);
  expect(container.querySelector('.is-waiting')).toBeNull();
  expect(screen.getByText('cancelled')).toBeTruthy();
});

it('keeps generated image cards outside the collapsed trace when a turn completes', () => {
  const messages: ChatMessage[] = [
    { ...message, id: 'user', type: 'user', isToolUse: false, content: 'draw' },
    { ...message, id: 'shell', toolId: 'shell', toolName: 'Bash', toolResult: { content: 'ok' } },
    { ...message, toolResult: { content: 'image attached' } },
    { ...message, id: 'answer', type: 'assistant', isToolUse: false, content: 'done' },
  ];
  const items = foldCompletedTurns(messages, buildRenderableMessageItems(messages), false);
  expect(items.some(item => item.message.toolName === 'generate_image')).toBe(true);
  expect(items.flatMap(item => item.turnTrace?.items ?? []).some(item => item.message.toolName === 'generate_image')).toBe(false);
});
