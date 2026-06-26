// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerV2, { type ComposerV2Props } from './ComposerV2';

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
});
