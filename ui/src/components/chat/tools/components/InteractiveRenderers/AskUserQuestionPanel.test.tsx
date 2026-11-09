import { I18nextProvider } from 'react-i18next';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../../../i18n/testInstance';
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
  it.each(['en', 'zh-CN'])('does not submit an IME confirmation in %s', async (language) => {
    const i18n = await createTestI18n(language);
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

    render(<I18nextProvider i18n={i18n}><AskUserQuestionPanel request={request} onDecision={onDecision} /></I18nextProvider>);

    fireEvent.click(screen.getByText(i18n.t('uiText.other')));
    const otherInput = screen.getByPlaceholderText(i18n.t('uiText.typeAnswer'));
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

it.each(['en', 'zh-CN'])('keeps multi-select choices and custom answers intact across question navigation (%s)', async language => {
  const i18n = await createTestI18n(language);
  const onDecision = vi.fn();
  const request = { requestId: 'multi-question', toolName: 'ask_user_question', input: { questions: [
    { question: 'Which paths?', header: 'Scope', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }, { label: 'D' }] },
    { question: 'How detailed?', header: 'Detail', options: [{ label: 'Summary' }, { label: 'Full' }] },
  ] } };
  render(<I18nextProvider i18n={i18n}><AskUserQuestionPanel request={request} onDecision={onDecision} /></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: /A, B/ }));
  fireEvent.click(screen.getByRole('button', { name: / C$/ }));
  fireEvent.click(screen.getByRole('button', { name: / D$/ }));
  fireEvent.click(screen.getByRole('button', { name: / C$/ }));
  fireEvent.click(screen.getByText(i18n.t('uiText.other')));
  fireEvent.change(screen.getByPlaceholderText(i18n.t('uiText.typeAnswer')), { target: { value: 'Custom, answer' } });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('uiText.next')) }));
  fireEvent.click(screen.getByRole('button', { name: /Summary/ }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('uiText.back')) }));
  expect(screen.getByRole('button', { name: /A, B/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: / D$/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: / C$/ }).getAttribute('aria-pressed')).toBe('false');
  expect((screen.getByPlaceholderText(i18n.t('uiText.typeAnswer')) as HTMLInputElement).value).toBe('Custom, answer');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('uiText.next')) }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('uiText.submit')) }));
  expect(onDecision).toHaveBeenCalledOnce();
  expect(onDecision).toHaveBeenCalledWith('multi-question', expect.objectContaining({ updatedInput: expect.objectContaining({
    answers: { 'Which paths?': ['A, B', 'D', 'Custom, answer'], 'How detailed?': 'Summary' },
  }) }));
});
