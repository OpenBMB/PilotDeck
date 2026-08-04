// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileSearchControls from './FileSearchControls';

afterEach(cleanup);

function SearchHarness({
  onNext = () => undefined,
  onClose = () => undefined,
}: {
  onNext?: () => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <>
      <FileSearchControls
        query={query}
        onQueryChange={setQuery}
        matchIndex={0}
        matchCount={1}
        onPrevious={() => undefined}
        onNext={onNext}
        onClose={onClose}
        searchLabel="Search this file"
        placeholder="Search in file"
        previousLabel="Previous"
        nextLabel="Next"
        closeLabel="Close"
        noMatchesLabel="No matches"
      />
      <output data-testid="committed-query">{query}</output>
    </>
  );
}

describe('FileSearchControls', () => {
  it('updates direct English input', () => {
    render(<SearchHarness />);
    const input = screen.getByRole('textbox', { name: 'Search this file' });

    fireEvent.change(input, { target: { value: 'pilot' } });

    expect((input as HTMLInputElement).value).toBe('pilot');
    expect(screen.getByTestId('committed-query').textContent).toBe('pilot');
  });

  it('preserves IME draft text until composition ends', () => {
    render(<SearchHarness />);
    const input = screen.getByRole('textbox', { name: 'Search this file' });

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'wen' } });

    expect((input as HTMLInputElement).value).toBe('wen');
    expect(screen.getByTestId('committed-query').textContent).toBe('');

    fireEvent.change(input, { target: { value: '文件' } });
    fireEvent.compositionEnd(input);

    expect((input as HTMLInputElement).value).toBe('文件');
    expect(screen.getByTestId('committed-query').textContent).toBe('文件');
  });

  it('does not navigate when IME Enter is reported with keyCode 229', () => {
    const onNext = vi.fn();
    render(<SearchHarness onNext={onNext} />);
    const input = screen.getByRole('textbox', { name: 'Search this file' });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, which: 229 });

    expect(onNext).not.toHaveBeenCalled();
  });

  it('handles Escape locally', () => {
    const onClose = vi.fn();
    const globalEscapeHandler = vi.fn();
    document.addEventListener('keydown', globalEscapeHandler);
    render(<SearchHarness onClose={onClose} />);
    const input = screen.getByRole('textbox', { name: 'Search this file' });

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(globalEscapeHandler).not.toHaveBeenCalled();
    document.removeEventListener('keydown', globalEscapeHandler);
  });
});
