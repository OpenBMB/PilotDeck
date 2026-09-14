// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

describe('Markdown special token literals', () => {
  it('shows a paragraph wrapped in bare think tags as literal text', () => {
    const content = '<think>这是一段示例文字，用于表达一个简单、清晰的想法。</think>';
    const { container } = render(<Markdown>{content}</Markdown>);

    expect(container.textContent).toBe(content);
    expect(container.querySelector('think')).toBeNull();
  });

  it('preserves bare tags as they arrive and after streaming finishes', () => {
    const content = '<think>这里是正文</think>AFTER_THINK';
    const { container, rerender } = render(<Markdown isStreaming>{''}</Markdown>);

    for (let end = 1; end <= content.length; end += 1) {
      const prefix = content.slice(0, end);
      rerender(<Markdown isStreaming>{prefix}</Markdown>);
      expect(container.textContent).toBe(prefix);
      expect(container.querySelector('think')).toBeNull();
    }
    rerender(<Markdown>{content}</Markdown>);
    expect(container.textContent).toBe(content);
  });

  it('preserves EOS examples and the text following them', () => {
    const content = 'BEGIN `<|endoftext|>` `<|endofprompt|>` `<|im_end|>` AFTER_EOS';
    const { container } = render(<Markdown>{content}</Markdown>);

    expect(container.textContent).toBe('BEGIN <|endoftext|> <|endofprompt|> <|im_end|> AFTER_EOS');
    expect(Array.from(container.querySelectorAll('code'), (node) => node.textContent))
      .toEqual(['<|endoftext|>', '<|endofprompt|>', '<|im_end|>']);
  });
});
