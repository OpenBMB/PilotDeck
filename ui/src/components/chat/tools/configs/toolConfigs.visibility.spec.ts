import { describe, expect, it } from 'vitest';
import { shouldHideToolResult } from './toolConfigs';

describe('shouldHideToolResult', () => {
  it('hides successful Read results but still shows Read errors', () => {
    expect(shouldHideToolResult('Read', { isError: false, content: 'file contents' })).toBe(true);
    expect(shouldHideToolResult('Read', { isError: true, content: 'file not found' })).toBe(false);
  });
});
