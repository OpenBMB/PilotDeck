import { describe, expect, it } from 'vitest';
import {
  createSpreadsheetContextSelectionIntent,
  shouldShowSpreadsheetSelectionPopup,
} from './spreadsheetContextSelectionIntent';

describe('shouldShowSpreadsheetSelectionPopup', () => {
  it('shows the popup only for an explicit context action', () => {
    expect(shouldShowSpreadsheetSelectionPopup('context-action', false)).toBe(true);
    expect(shouldShowSpreadsheetSelectionPopup('passive', false)).toBe(false);
  });

  it('suppresses the popup while region selection is active', () => {
    expect(shouldShowSpreadsheetSelectionPopup('context-action', true)).toBe(false);
  });
});

describe('createSpreadsheetContextSelectionIntent', () => {
  it('ignores ordinary left-click cell selection', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(0);

    expect(intent.recordCellPointerDown('B3')).toBe(false);
    expect(intent.consumeContextAction()).toBeNull();
  });

  it('returns the cell target for a secondary-button context action', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(2);

    expect(intent.recordCellPointerDown('B3')).toBe(true);
    expect(intent.consumeContextAction()).toBe('B3');
  });

  it('treats macOS Ctrl+click as a context action', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(0, true);

    expect(intent.recordCellPointerDown('B3')).toBe(true);
    expect(intent.consumeContextAction()).toBe('B3');
  });

  it('does not treat a right-click outside the cell canvas as a cell action', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(2);

    expect(intent.consumeContextAction()).toBeNull();
  });

  it('consumes each right-click intent only once', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(2);
    intent.recordCellPointerDown('C4');

    expect(intent.consumeContextAction()).toBe('C4');
    expect(intent.consumeContextAction()).toBeNull();
  });

  it('clears a pending right-click when the next pointer action is a left click', () => {
    const intent = createSpreadsheetContextSelectionIntent<string>();

    intent.recordPointerDown(2);
    intent.recordCellPointerDown('D5');
    intent.recordPointerDown(0);

    expect(intent.consumeContextAction()).toBeNull();
  });
});
