// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamingThinkingPreview } from './ProcessTrace';

afterEach(() => {
  cleanup();
});

describe('StreamingThinkingPreview', () => {
  const content = Array.from({ length: 12 }, (_, index) => `Thinking line ${index + 1}`).join('\n');

  it('keeps the compact tail for non-scrollable previews', () => {
    render(<StreamingThinkingPreview content={content} />);

    expect(screen.queryByText('Thinking line 1')).toBeNull();
    expect(screen.getByText('Thinking line 12')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Live thinking content' })).toBeNull();
  });

  it('shows the full live reasoning in a scrollable window without extra controls', () => {
    render(<StreamingThinkingPreview content={content} scrollable />);

    const region = screen.getByRole('region', { name: 'Live thinking content' });
    expect(region.textContent).toContain('Thinking line 1');
    expect(region.textContent).toContain('Thinking line 12');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('pauses live following while the user reads older reasoning and resumes at the bottom', () => {
    const view = render(<StreamingThinkingPreview content={content} scrollable />);

    const region = screen.getByRole('region', { name: 'Live thinking content' });
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 200 });
    region.scrollTop = 100;
    fireEvent.scroll(region);

    view.rerender(
      <StreamingThinkingPreview content={`${content}\nA newly streamed thinking line`} scrollable />,
    );
    expect(region.scrollTop).toBe(100);

    region.scrollTop = 400;
    fireEvent.scroll(region);
    view.rerender(
      <StreamingThinkingPreview content={`${content}\nA newly streamed thinking line\nAnother line`} scrollable />,
    );

    expect(region.scrollTop).toBe(600);
  });
});
