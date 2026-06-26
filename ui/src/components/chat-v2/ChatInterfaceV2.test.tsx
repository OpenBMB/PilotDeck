// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldAbortSessionOnGlobalEscapeForTest } from './ChatInterfaceV2';

const makeGlobalEscapeEvent = (
  overrides: Partial<Pick<KeyboardEvent, 'key' | 'repeat' | 'defaultPrevented' | 'target'>> = {},
) => ({
  key: 'Escape',
  repeat: false,
  defaultPrevented: false,
  target: document.body,
  ...overrides,
}) as Pick<KeyboardEvent, 'key' | 'repeat' | 'defaultPrevented' | 'target'>;

describe('ChatInterfaceV2 global Escape handling', () => {
  it('aborts only for a fresh unhandled Escape outside protected UI', () => {
    expect(shouldAbortSessionOnGlobalEscapeForTest(makeGlobalEscapeEvent(), false)).toBe(true);
  });

  it('ignores non-Escape, repeated, and already-handled key events', () => {
    expect(shouldAbortSessionOnGlobalEscapeForTest(makeGlobalEscapeEvent({ key: 'Enter' }), false)).toBe(false);
    expect(shouldAbortSessionOnGlobalEscapeForTest(makeGlobalEscapeEvent({ repeat: true }), false)).toBe(false);
    expect(shouldAbortSessionOnGlobalEscapeForTest(makeGlobalEscapeEvent({ defaultPrevented: true }), false)).toBe(false);
  });

  it('does not abort while modal overlays or composer popovers own Escape', () => {
    const popoverButton = document.createElement('button');
    const popoverScope = document.createElement('div');
    popoverScope.dataset.composerPopoverScope = 'true';
    popoverScope.appendChild(popoverButton);
    document.body.appendChild(popoverScope);

    try {
      expect(shouldAbortSessionOnGlobalEscapeForTest(makeGlobalEscapeEvent(), true)).toBe(false);
      expect(
        shouldAbortSessionOnGlobalEscapeForTest(
          makeGlobalEscapeEvent({ target: popoverButton }),
          false,
        ),
      ).toBe(false);
    } finally {
      popoverScope.remove();
    }
  });
});
