// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FindShortcutProvider,
  useRegisterFindShortcutTarget,
  type FindShortcutScope,
} from './FindShortcutContext';

type TargetProps = {
  scope: FindShortcutScope;
  label: string;
  onOpen: () => void;
  captureInModal?: boolean;
};

function Target({ scope, label, onOpen, captureInModal = false }: TargetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useRegisterFindShortcutTarget({
    scope,
    containerRef,
    onOpen,
    captureInModal,
  });

  return (
    <div
      ref={containerRef}
      data-file-search-surface={scope === 'file' ? '' : undefined}
      data-chat-search-surface={scope === 'chat' ? '' : undefined}
    >
      <button type="button">{label}</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('FindShortcutProvider', () => {
  it('routes a body-level shortcut to the active file scope', () => {
    const openFile = vi.fn();
    const openChat = vi.fn();
    render(
      <FindShortcutProvider activeScope="file">
        <Target scope="chat" label="Chat content" onOpen={openChat} />
        <Target scope="file" label="File content" onOpen={openFile} />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openChat).not.toHaveBeenCalled();
  });

  it('lets an explicitly focused chat surface override the Files default', () => {
    const openFile = vi.fn();
    const openChat = vi.fn();
    render(
      <FindShortcutProvider activeScope="file">
        <Target scope="chat" label="Chat content" onOpen={openChat} />
        <Target scope="file" label="File content" onOpen={openFile} />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Chat content' }), {
      key: 'f',
      metaKey: true,
    });

    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();
  });

  it('does not fall through to chat when Files has no searchable target', () => {
    const openChat = vi.fn();
    render(
      <FindShortcutProvider activeScope="file">
        <Target scope="chat" label="Chat content" onOpen={openChat} />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(openChat).not.toHaveBeenCalled();
  });

  it('ignores focus left inside a hidden chat surface when Files is active', () => {
    const openFile = vi.fn();
    const openChat = vi.fn();
    render(
      <FindShortcutProvider activeScope="file">
        <div aria-hidden="true">
          <Target scope="chat" label="Hidden chat content" onOpen={openChat} />
        </div>
        <Target scope="file" label="File content" onOpen={openFile} />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Hidden chat content', hidden: true }), {
      key: 'f',
      ctrlKey: true,
    });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openChat).not.toHaveBeenCalled();
  });

  it('gives a modal search target priority over the active page scope', () => {
    const openFile = vi.fn();
    const openModal = vi.fn();
    render(
      <FindShortcutProvider activeScope="file">
        <Target scope="file" label="File content" onOpen={openFile} />
        <div data-modal-overlay>
          <Target
            scope="chat"
            label="Modal content"
            onOpen={openModal}
            captureInModal
          />
        </div>
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(openModal).toHaveBeenCalledTimes(1);
    expect(openFile).not.toHaveBeenCalled();
  });
});
