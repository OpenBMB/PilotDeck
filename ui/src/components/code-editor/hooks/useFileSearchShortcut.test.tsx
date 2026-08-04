// @vitest-environment jsdom
import { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindShortcutProvider } from '../../../contexts/FindShortcutContext';
import { useFileSearchShortcut } from './useFileSearchShortcut';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ShortcutHarness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);
  useFileSearchShortcut({ containerRef, onOpen: openSearch });

  return (
    <div ref={containerRef}>
      <button type="button">File content</button>
      {open ? <input data-file-search-input aria-label="File search" /> : null}
    </div>
  );
}

describe('useFileSearchShortcut', () => {
  it('opens file search for Cmd/Ctrl+F originating in the file surface', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    render(
      <FindShortcutProvider activeScope="file">
        <ShortcutHarness />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'File content' }), {
      key: 'f',
      ctrlKey: true,
    });

    expect(screen.queryByRole('textbox', { name: 'File search' })).not.toBeNull();
  });

  it('opens file search from the document while the file scope is active', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    render(
      <FindShortcutProvider activeScope="file">
        <ShortcutHarness />
      </FindShortcutProvider>,
    );

    fireEvent.keyDown(document, { key: 'f', metaKey: true });

    expect(screen.queryByRole('textbox', { name: 'File search' })).not.toBeNull();
  });
});
