import { describe, expect, it } from 'vitest';
import { getToolConfig, shouldHideToolResult } from './toolConfigs';

describe('shouldHideToolResult', () => {
  it('hides successful Read results but still shows Read errors', () => {
    expect(shouldHideToolResult('Read', { isError: false, content: 'file contents' })).toBe(true);
    expect(shouldHideToolResult('Read', { isError: true, content: 'file not found' })).toBe(false);
  });
});

describe('group chat tool display', () => {
  it('keeps group collaboration visible with an expanded markdown transcript', () => {
    const config = getToolConfig('group_chat');
    expect(config.input.type).toBe('collapsible');
    expect(config.result?.contentType).toBe('markdown');
    expect(config.result?.defaultOpen).toBe(true);
  });
});
