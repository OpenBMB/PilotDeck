// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionPanel } from './AskUserQuestionPanel';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AskUserQuestionPanel IME behavior', () => {
  it('does not submit the Other input when Enter confirms IME composition', () => {
    const onDecision = vi.fn();
    const request = {
      requestId: 'request-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Choose a path',
            options: [{ label: 'Default', description: 'Use the default path' }],
          },
        ],
      },
    };

    render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);

    fireEvent.click(screen.getByText('Other...'));
    const otherInput = screen.getByPlaceholderText('Type your answer...');
    fireEvent.change(otherInput, { target: { value: 'nihao' } });

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
    });
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    });

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(
      'request-1',
      expect.objectContaining({
        allow: true,
        updatedInput: expect.objectContaining({
          answers: { 'Choose a path': 'nihao' },
        }),
      }),
    );
  });
});
