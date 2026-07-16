import type { ReactNode } from 'react';
import { getEditorLoadingStyles } from '../../utils/editorStyles';

type CodeEditorLoadingStateProps = {
  isDarkMode: boolean;
  isSidebar: boolean;
  loadingText: string;
  headerPrefix?: ReactNode;
};

export default function CodeEditorLoadingState({
  isDarkMode,
  isSidebar,
  loadingText,
  headerPrefix,
}: CodeEditorLoadingStateProps) {
  const spinner = (
    <div className="flex items-center gap-3 text-[13px] text-neutral-600 dark:text-neutral-300">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-neutral-100" />
      <span>{loadingText}</span>
    </div>
  );

  return (
    <>
      <style>{getEditorLoadingStyles(isDarkMode)}</style>
      {isSidebar ? (
        <div className="flex h-full w-full flex-col bg-white dark:bg-neutral-950">
          {headerPrefix}
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {spinner}
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/40 md:backdrop-blur-sm">
          <div className="code-editor-loading flex h-full w-full flex-col bg-white dark:bg-neutral-950 md:h-[80vh] md:max-h-[80vh] md:max-w-6xl md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800">
            {headerPrefix}
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
              {spinner}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
