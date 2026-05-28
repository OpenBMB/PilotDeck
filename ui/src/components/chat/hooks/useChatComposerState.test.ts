import { describe, expect, it } from 'vitest';
import { shouldCycleRunModeOnKeyDown } from './useChatComposerState';

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey };
}

describe('useChatComposerState keyboard shortcuts', () => {
  it('uses Shift+Tab to cycle run mode when no completion menu is open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(true);
  });

  it('does not cycle run mode for plain Tab or while menus are open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab'), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: true,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: true,
    })).toBe(false);
  });
});
