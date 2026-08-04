import type { ComponentProps } from 'react';
import FileSearchControls from './FileSearchControls';

type FloatingFileSearchControlsProps = ComponentProps<typeof FileSearchControls>;

export default function FloatingFileSearchControls({
  className = '',
  ...props
}: FloatingFileSearchControlsProps) {
  return (
    <div
      data-file-search-exclude
      data-file-search-overlay
      className="pointer-events-none absolute inset-x-2 top-full z-30 mt-2 flex justify-end sm:inset-x-3"
    >
      <FileSearchControls
        {...props}
        className={[
          'pointer-events-auto w-full max-w-sm flex-none shadow-lg ring-1 ring-black/5',
          'dark:shadow-black/40 dark:ring-white/10',
          className,
        ].join(' ')}
      />
    </div>
  );
}
