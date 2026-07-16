import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  onGoBack?: () => void;
  canGoBack?: boolean;
  dependency: string;
  enabled?: boolean;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  onGoBack,
  canGoBack = false,
  dependency,
  enabled = true,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (canGoBack && onGoBack) {
          onGoBack();
          return;
        }
        onClose();
        return;
      }

      if (event.key === 'Backspace' && event.altKey && canGoBack && onGoBack) {
        event.preventDefault();
        onGoBack();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [canGoBack, dependency, enabled, onClose, onGoBack, onSave]);
};
