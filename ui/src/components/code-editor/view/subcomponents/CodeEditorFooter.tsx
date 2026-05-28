type CodeEditorFooterProps = {
  content: string;
  linesLabel: string;
  charactersLabel: string;
  shortcutsLabel: string;
};

export default function CodeEditorFooter({
  content,
  linesLabel,
  charactersLabel,
  shortcutsLabel,
}: CodeEditorFooterProps) {
  return (
    <div className="text-xxs flex flex-shrink-0 items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
        <span>
          {linesLabel} {content.split('\n').length}
        </span>
        <span>
          {charactersLabel} {content.length}
        </span>
      </div>

      <div className="text-neutral-500 dark:text-neutral-400">{shortcutsLabel}</div>
    </div>
  );
}
