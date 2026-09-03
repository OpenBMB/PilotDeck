import { describe, expect, it } from 'vitest';
import { getParentPath } from './pathUtils';

describe('project creation path utilities', () => {
  it('moves from Windows drive roots to the virtual drives view', () => {
    expect(getParentPath('C:\\')).toBe('/');
    expect(getParentPath('D:')).toBe('/');
  });

  it('stops at filesystem roots', () => {
    expect(getParentPath('/')).toBeNull();
  });

  it('keeps normal Windows parent navigation under a drive', () => {
    expect(getParentPath('D:\\Projects\\PilotDeck')).toBe('D:\\Projects');
    expect(getParentPath('D:\\Projects')).toBe('D:\\');
  });
});
