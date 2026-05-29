import { describe, it, expect } from 'vitest';
import { TurnInputProcessor } from '../../../src/agent/turn/TurnInputProcessor.js';

describe('TurnInputProcessor', () => {
  const processor = new TurnInputProcessor();

  it('processes text input', () => {
    const result = processor.accept({
      type: 'text',
      text: 'Hello agent!',
    });
    expect(result.shouldCallModel).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toEqual([
      { type: 'text', text: 'Hello agent!' },
    ]);
  });

  it('processes content input', () => {
    const result = processor.accept({
      type: 'content',
      content: [
        { type: 'text', text: 'Analyze this file' },
      ],
    });
    expect(result.shouldCallModel).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toHaveLength(1);
  });

  it('processes content input with multiple blocks', () => {
    const result = processor.accept({
      type: 'content',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: 'base64', data: 'AAAA', mimeType: 'image/png' },
      ],
    });
    expect(result.shouldCallModel).toBe(true);
    expect(result.messages[0]!.content).toHaveLength(2);
    expect(result.messages[0]!.content[1]!.type).toBe('image');
  });
});
