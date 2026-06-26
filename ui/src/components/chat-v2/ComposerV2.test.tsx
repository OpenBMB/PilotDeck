// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerV2, { getQueuedInputRowsForTest, type ComposerV2Props } from './ComposerV2';

afterEach(() => {
  cleanup();
});

const noop = vi.fn();

function renderComposer(overrides: Partial<ComposerV2Props> = {}) {
  const props: ComposerV2Props = {
    input: 'Please review this screenshot',
    placeholder: 'Tell PilotDeck what you want to get done...',
    textareaRef: React.createRef<HTMLTextAreaElement>(),
    inputHighlightRef: React.createRef<HTMLDivElement>(),
    renderInputWithMentions: (text) => text,
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    onInputFocusChange: noop,
    onSubmit: noop,
    onAbortSession: noop,
    openImagePicker: noop,
    attachedImages: [],
    onRemoveImage: noop,
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    onToggleCommandMenu: noop,
    onInsertMention: noop,
    onInsertSlash: noop,
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    isLoading: false,
    canAbortSession: false,
    isAbortPending: false,
    isSubmitPending: false,
    queuedInputs: [],
    onUpdateQueuedInput: noop,
    onRemoveQueuedInput: noop,
    onMoveQueuedInputUp: noop,
    onMoveQueuedInputDown: noop,
    tokenBudget: null,
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    permissionMode: 'default',
    onPermissionModeChange: noop,
    runMode: 'agent',
    onRunModeChange: noop,
    planModeAvailable: true,
    onPlanExecutionApproved: noop,
    sendByCtrlEnter: false,
    chromeless: false,
    ...overrides,
  };

  return render(<ComposerV2 {...props} />);
}

describe('ComposerV2 queue feedback', () => {
  it('sizes queued editors to show multiline content without expanding forever', () => {
    expect(getQueuedInputRowsForTest('one line')).toBe(1);
    expect(getQueuedInputRowsForTest('line one\nline two\nline three')).toBe(3);
    expect(getQueuedInputRowsForTest('1\n2\n3\n4\n5\n6')).toBe(4);
    expect(getQueuedInputRowsForTest('x'.repeat(160))).toBe(3);
  });

  it('gives icon-only composer controls stable accessible names', () => {
    renderComposer();

    expect(screen.getByRole('button', { name: 'Attach photos or files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mention a file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run a slash command' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('exposes file mention suggestions as selectable options', () => {
    renderComposer({
      showFileDropdown: true,
      selectedFileIndex: 1,
      filteredFiles: [
        { name: 'README.md', path: 'README.md' },
        { name: 'ComposerV2.tsx', path: 'ui/src/components/chat-v2/ComposerV2.tsx' },
      ],
    });

    expect(screen.getByRole('listbox', { name: 'File suggestions' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /README.md/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('option', { name: /ComposerV2.tsx/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('connects the composer textbox to active file mention suggestions', () => {
    renderComposer({
      showFileDropdown: true,
      selectedFileIndex: 1,
      filteredFiles: [
        { name: 'README.md', path: 'README.md' },
        { name: 'ComposerV2.tsx', path: 'ui/src/components/chat-v2/ComposerV2.tsx' },
      ],
    });

    const textarea = screen.getByPlaceholderText('Tell PilotDeck what you want to get done...');
    const listbox = screen.getByRole('listbox', { name: 'File suggestions' });
    const selectedOption = screen.getByRole('option', { name: /ComposerV2.tsx/ });

    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe(listbox.id);
    expect(textarea.getAttribute('aria-activedescendant')).toBe(selectedOption.id);
  });

  it('connects the composer textbox to active slash command suggestions', () => {
    renderComposer({
      isCommandMenuOpen: true,
      selectedCommandIndex: 1,
      filteredCommands: [
        { name: '/clear', description: 'Clear chat' },
        { name: '/skill_install', description: 'Install a skill' },
      ],
    });

    const textarea = screen.getByPlaceholderText('Tell PilotDeck what you want to get done...');
    const listbox = screen.getByRole('listbox', { name: 'Available commands' });
    const selectedOption = screen.getByRole('option', { name: /\/skill_install/ });

    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe(listbox.id);
    expect(textarea.getAttribute('aria-activedescendant')).toBe(selectedOption.id);
  });

  it('keeps the composer textbox expanded for an empty slash command menu', () => {
    renderComposer({
      isCommandMenuOpen: true,
      selectedCommandIndex: -1,
      filteredCommands: [],
    });

    const textarea = screen.getByPlaceholderText('Tell PilotDeck what you want to get done...');
    const listbox = screen.getByRole('listbox', { name: 'Available commands' });

    expect(listbox.textContent).toContain('No commands available');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe(listbox.id);
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('exposes a toolbar button for slash commands', () => {
    const onInsertSlash = vi.fn();
    renderComposer({ onInsertSlash });

    screen.getByTitle('Run a slash command').click();

    expect(onInsertSlash).toHaveBeenCalledTimes(1);
  });

  it('closes the slash command menu instead of inserting another slash when already open', () => {
    const onInsertSlash = vi.fn();
    const onCloseCommandMenu = vi.fn();
    renderComposer({
      isCommandMenuOpen: true,
      onInsertSlash,
      onCloseCommandMenu,
      filteredCommands: [{ name: '/skill_install', description: 'Install a skill' }],
    });

    const slashButton = screen.getByTitle('Run a slash command');
    fireEvent.mouseDown(slashButton);
    fireEvent.click(slashButton);

    expect(onCloseCommandMenu).toHaveBeenCalledTimes(1);
    expect(onInsertSlash).not.toHaveBeenCalled();
  });

  it('keeps only one composer popover open at a time', () => {
    renderComposer();

    fireEvent.click(screen.getByTitle('Select run mode'));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Plan/ })).toBeTruthy();

    fireEvent.click(screen.getByTitle('Select permission mode'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.queryByRole('menuitemradio', { name: /Plan/ })).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: /Full Access/ })).toBeTruthy();

    fireEvent.click(screen.getByTitle('Context usage unknown. It will appear after the next model response.'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Context window');
  });

  it('closes composer popovers before running toolbar actions', () => {
    const openImagePicker = vi.fn();
    const onInsertMention = vi.fn();
    const onInsertSlash = vi.fn();
    renderComposer({ openImagePicker, onInsertMention, onInsertSlash });

    fireEvent.click(screen.getByTitle('Select permission mode'));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Attach photos or files'));
    expect(openImagePicker).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTitle('Select permission mode'));
    fireEvent.click(screen.getByTitle('Mention a file'));
    expect(onInsertMention).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTitle('Select run mode'));
    fireEvent.click(screen.getByTitle('Run a slash command'));
    expect(onInsertSlash).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes composer popovers before keyboard/form submit', () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });
    renderComposer({ onSubmit });

    fireEvent.click(screen.getByTitle('Select run mode'));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.submit(
      screen.getByPlaceholderText('Tell PilotDeck what you want to get done...').closest('form') as HTMLFormElement,
    );

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows a visible explanation when attachments cannot be queued', () => {
    renderComposer({
      isLoading: true,
      attachedImages: [new File(['image'], 'screen.png', { type: 'image/png' })],
    });

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Attachments cannot be queued');

    const submitButton = screen.getByTitle('Attachments cannot be queued. Wait for the current run to finish, then send this message.');
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);
    expect(submitButton.getAttribute('aria-describedby')).toBe(status.id);
  });

  it('marks blank queued messages instead of letting them disappear silently', () => {
    renderComposer({
      input: '',
      queuedInputs: [
        {
          id: 'queued-blank',
          content: '   ',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 1,
        },
      ],
    });

    const queuedEditor = screen.getByRole('textbox', { name: 'Edit queued message 1' });
    const status = screen.getByRole('status');

    expect(queuedEditor.getAttribute('aria-invalid')).toBe('true');
    expect(queuedEditor.getAttribute('aria-describedby')).toBe(status.id);
    expect(status.textContent).toContain('Empty queued messages will not send');
  });

  it('gives queued message icon controls stable accessible names', () => {
    renderComposer({
      input: '',
      queuedInputs: [
        {
          id: 'queued-first',
          content: 'first queued message',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 1,
        },
        {
          id: 'queued-second',
          content: 'second queued message',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 2,
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'Move queued message 1 up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move queued message 1 down' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove queued message 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move queued message 2 up' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move queued message 2 down' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove queued message 2' })).toBeTruthy();
  });

  it('shows multiline queued messages with more editing context', () => {
    renderComposer({
      input: '',
      queuedInputs: [
        {
          id: 'queued-multiline',
          content: 'first line\nsecond line\nthird line',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 1,
        },
      ],
    });

    const queuedEditor = screen.getByRole('textbox', { name: 'Edit queued message 1' });

    expect(queuedEditor.getAttribute('rows')).toBe('3');
  });

  it('shows a paused queue status when the first queued message cannot send', () => {
    renderComposer({
      input: '',
      isLoading: false,
      queuedInputs: [
        {
          id: 'queued-blank',
          content: '   ',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 1,
        },
        {
          id: 'queued-ready',
          content: 'send this after the blank item is fixed',
          files: [],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 2,
        },
      ],
    });

    expect(screen.getByText('Fix first item to continue')).toBeTruthy();
    expect(screen.queryByText('Sending next')).toBeNull();
  });

  it('marks queued attachments as blocked instead of presenting them as sendable', () => {
    renderComposer({
      input: '',
      queuedInputs: [
        {
          id: 'queued-file',
          content: 'send this with the screenshot',
          files: [new File(['image'], 'screen.png', { type: 'image/png' })],
          thinkingMode: 'none',
          targetSessionId: 'session-1',
          createdAt: 1,
        },
      ],
    });

    const queuedEditor = screen.getByRole('textbox', { name: 'Edit queued message 1' });
    const status = screen.getByRole('status');

    expect(queuedEditor.getAttribute('aria-invalid')).toBe('true');
    expect(queuedEditor.getAttribute('aria-describedby')).toBe(status.id);
    expect(status.textContent).toContain('queued attachment');
    expect(screen.getByText('Fix first item to continue')).toBeTruthy();
  });
});
