export type SpreadsheetContextSelectionIntent<T> = {
  recordPointerDown: (button: number, ctrlKey?: boolean) => void;
  recordCellPointerDown: (target: T) => boolean;
  consumeContextAction: () => T | null;
  reset: () => void;
};

export type SpreadsheetSelectionOrigin = 'context-action' | 'passive';

export function shouldShowSpreadsheetSelectionPopup(
  origin: SpreadsheetSelectionOrigin,
  regionModeActive: boolean,
): boolean {
  return origin === 'context-action' && !regionModeActive;
}

export function createSpreadsheetContextSelectionIntent<T>(): SpreadsheetContextSelectionIntent<T> {
  let secondaryPointerArmed = false;
  let cellTarget: T | null = null;

  const reset = () => {
    secondaryPointerArmed = false;
    cellTarget = null;
  };

  return {
    recordPointerDown(button, ctrlKey = false) {
      secondaryPointerArmed = button === 2 || (button === 0 && ctrlKey);
      if (!secondaryPointerArmed) cellTarget = null;
    },
    recordCellPointerDown(target) {
      if (!secondaryPointerArmed) return false;
      cellTarget = target;
      return true;
    },
    consumeContextAction() {
      const target = cellTarget;
      reset();
      return target;
    },
    reset,
  };
}
