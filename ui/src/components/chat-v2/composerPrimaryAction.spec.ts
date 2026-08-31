import { describe, expect, it } from 'vitest';
import { getComposerPrimaryAction } from './composerPrimaryAction';

describe('ComposerV2 primary action', () => {
  it('lets an active response queue a non-empty draft', () => {
    expect(getComposerPrimaryAction({
      isLoading: true,
      isInputQueuePaused: false,
      hasDraftContent: false,
    })).toBe('stop');
    expect(getComposerPrimaryAction({
      isLoading: true,
      isInputQueuePaused: false,
      hasDraftContent: true,
    })).toBe('send');
  });

  it('shows Continue only for an idle paused queue with an empty draft', () => {
    expect(getComposerPrimaryAction({
      isLoading: false,
      isInputQueuePaused: true,
      hasDraftContent: false,
    })).toBe('resume');
    expect(getComposerPrimaryAction({
      isLoading: false,
      isInputQueuePaused: true,
      hasDraftContent: true,
    })).toBe('send');
  });
});
