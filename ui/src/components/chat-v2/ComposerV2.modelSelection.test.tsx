// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelCatalogItem, ChatModelSelection } from '../chat/hooks/useChatProviderState';
import ComposerV2, { type ComposerV2Props } from './ComposerV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const modelCatalog: ChatModelCatalogItem[] = [
  {
    id: 'minimax/MiniMax-M3', provider: 'minimax', model: 'MiniMax-M3',
    displayName: 'MiniMax M3', available: true, capabilities: {},
  },
  {
    id: 'minimax/MiniMax-M2.7-highspeed', provider: 'minimax', model: 'MiniMax-M2.7-highspeed',
    displayName: 'MiniMax M2.7 Highspeed', available: true,
    capabilities: { temperature: { type: 'range', min: 0, max: 1, step: 0.1 } },
  },
  {
    id: 'router/auto', provider: 'router', model: 'auto',
    displayName: 'Auto', available: true, capabilities: {},
  },
];

const initialSelection: ChatModelSelection = {
  mode: 'model', provider: 'minimax', model: 'MiniMax-M3',
};
const targetSelection: ChatModelSelection = {
  mode: 'model', provider: 'minimax', model: 'MiniMax-M2.7-highspeed',
};
const noop = () => {};

function renderComposer() {
  const onModelSelectionChange = vi.fn();

  function ControlledComposer() {
    const [modelSelection, setModelSelection] = useState<ChatModelSelection>(initialSelection);
    const props: ComposerV2Props = {
      input: '', placeholder: 'Message', textareaRef: createRef(), inputHighlightRef: createRef(),
      renderInputWithMentions: (text) => text,
      onInputChange: noop, onTextareaClick: noop, onTextareaKeyDown: noop,
      onTextareaPaste: noop, onTextareaScrollSync: noop, onTextareaInput: noop,
      onSubmit: noop, onAbortSession: noop, openImagePicker: noop,
      onAddAttachmentFiles: noop, attachedImages: [], onRemoveImage: noop, onRetryImage: noop,
      documentReferences: [], onRemoveDocumentReference: noop,
      uploadingImages: new Map(), imageErrors: new Map(),
      showFileDropdown: false, fileMentionQuery: '', filteredFiles: [], selectedFileIndex: 0,
      isLoadingFiles: false, fileListError: null, hasMoreFiles: false, onLoadMoreFiles: noop,
      onSelectFile: noop, selectedFileMentions: [], onRemoveFileMention: noop,
      selectedSkills: [], onSelectSkill: noop, onRemoveSkill: noop,
      selectedCommands: [], onRemoveCommand: noop,
      filteredCommands: [], commandQuery: '', selectedCommandIndex: 0, onCommandSelect: noop,
      onCloseCommandMenu: noop, isCommandMenuOpen: false, frequentCommands: [],
      onToggleCommandMenu: noop, onInsertSlash: noop,
      getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false,
      isLoading: false, canAbortSession: false, modelCatalog, modelSelection,
      projectKey: '', pendingPermissionRequests: [], handlePermissionDecision: noop,
      handleGrantToolPermission: () => ({ success: true }),
      permissionMode: 'default', onPermissionModeChange: noop,
      runMode: 'agent', onRunModeChange: noop,
      onModelSelectionChange: (selection) => {
        onModelSelectionChange(selection);
        setModelSelection(selection);
      },
    };

    return <><ComposerV2 {...props} /><button type="button">Outside composer</button></>;
  }

  render(<ControlledComposer />);
  fireEvent.click(screen.getByRole('button', { name: 'MiniMax M3' }));
  const search = screen.getByRole('searchbox') as HTMLInputElement;
  expect(document.activeElement).toBe(search);
  return { onModelSelectionChange, search };
}

function modelButton(name = 'MiniMax M2.7 Highspeed') {
  return within(screen.getByRole('dialog', { name: 'Select model' }))
    .getByRole('button', { name });
}

// jsdom does not perform the browser's default mouse focus action. Emulate
// Safari: a button press blurs the search input without focusing the button,
// unless the press's default action was canceled. React must flush that blur
// before the subsequent mouseup/click, just as separate native events do.
function safariClick(button: HTMLElement) {
  const runsDefaultAction = fireEvent.mouseDown(button, { button: 0 });
  if (runsDefaultAction && document.activeElement instanceof HTMLElement) {
    const focused = document.activeElement;
    act(() => focused.blur());
  }
  fireEvent.mouseUp(button, { button: 0 });
  fireEvent.click(button, { button: 0 });
}

function expectSelected(name: string) {
  expect(screen.queryByRole('dialog', { name: 'Select model' })).toBeNull();
  expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
}

afterEach(cleanup);

describe('ComposerV2 model selection focus handling', () => {
  it.each([
    ['MiniMax M2.7 Highspeed', targetSelection],
    ['Auto', { mode: 'auto' }],
  ])('selects %s directly with Safari mouse focus behavior', (name, selection) => {
    const { onModelSelectionChange } = renderComposer();

    safariClick(modelButton(name));

    expect(onModelSelectionChange).toHaveBeenCalledExactlyOnceWith(selection);
    expectSelected(name);
  });

  it('selects a filtered model directly while the search box is focused', () => {
    const { onModelSelectionChange, search } = renderComposer();
    fireEvent.change(search, { target: { value: 'Highspeed' } });

    safariClick(modelButton());

    expect(onModelSelectionChange).toHaveBeenCalledExactlyOnceWith(targetSelection);
    expectSelected('MiniMax M2.7 Highspeed');
  });

  it('selects a model with browsers that focus buttons on mouse down', () => {
    const { onModelSelectionChange } = renderComposer();
    const button = modelButton();
    if (fireEvent.mouseDown(button, { button: 0 })) {
      act(() => button.focus());
    }
    fireEvent.mouseUp(button, { button: 0 });
    fireEvent.click(button, { button: 0 });

    expect(onModelSelectionChange).toHaveBeenCalledExactlyOnceWith(targetSelection);
    expectSelected('MiniMax M2.7 Highspeed');
  });

  it('keeps the menu open during keyboard focus transfer and accepts keyboard activation', () => {
    const { onModelSelectionChange } = renderComposer();
    const button = modelButton();
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('dialog', { name: 'Select model' })).toBeTruthy();

    // Native buttons emit a click with detail=0 for keyboard activation;
    // no pointer or mouse down handler is involved.
    fireEvent.click(button, { detail: 0 });

    expect(onModelSelectionChange).toHaveBeenCalledExactlyOnceWith(targetSelection);
    expectSelected('MiniMax M2.7 Highspeed');
  });

  it('keeps advanced settings usable and preserves changed parameters when selecting that model', () => {
    const { onModelSelectionChange, search } = renderComposer();
    safariClick(screen.getByRole('button', { name: 'Advanced settings' }));
    expect(document.activeElement).toBe(search);
    expect(onModelSelectionChange).not.toHaveBeenCalled();

    const temperature = screen.getByRole('slider', { name: 'Temperature' });
    act(() => temperature.focus());
    fireEvent.change(temperature, { target: { value: '0.6' } });
    expect(onModelSelectionChange).toHaveBeenLastCalledWith({ ...targetSelection, temperature: 0.6 });
    expect(screen.getByRole('dialog', { name: 'Select model' })).toBeTruthy();

    safariClick(modelButton());

    expect(onModelSelectionChange).toHaveBeenCalledTimes(2);
    expect(onModelSelectionChange).toHaveBeenLastCalledWith({ ...targetSelection, temperature: 0.6 });
    expectSelected('MiniMax M2.7 Highspeed');
  });

  it.each(['outside', 'none'])('closes without changing the model when focus moves to %s', (destination) => {
    const { onModelSelectionChange, search } = renderComposer();
    act(() => {
      if (destination === 'outside') screen.getByRole('button', { name: 'Outside composer' }).focus();
      else search.blur();
    });

    expect(onModelSelectionChange).not.toHaveBeenCalled();
    expectSelected('MiniMax M3');
  });
});
