import { getEditorLoadingStyles } from '../../utils/editorStyles';

type CodeEditorLoadingStateProps = {
  isDarkMode: boolean;
  isSidebar: boolean;
  loadingText: string;
};

export default function CodeEditorLoadingState({
  isDarkMode,
  isSidebar,
  loadingText,
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
        <div className="flex h-full w-full items-center justify-center bg-white dark:bg-neutral-950">
          {spinner}
        </div>
      ) : (
        <div className="fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/40 md:backdrop-blur-sm">
          <div className="code-editor-loading flex h-full w-full items-center justify-center bg-white p-8 dark:bg-neutral-950 md:h-auto md:w-auto md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800">
            {spinner}
          </div>
        </div>
      )}
    </>
  );
}
