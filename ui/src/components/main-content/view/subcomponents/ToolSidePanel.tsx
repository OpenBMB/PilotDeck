import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';

type ToolSidePanelProps = {
  title: string;
  icon: LucideIcon;
  width: number;
  minWidth: number;
  maxWidth: number;
  isMobile: boolean;
  closeLabel: string;
  resizeLabel: string;
  onClose: () => void;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onResizeBy: (delta: number) => void;
  children: ReactNode;
};

export default function ToolSidePanel({
  title,
  icon: Icon,
  width,
  minWidth,
  maxWidth,
  isMobile,
  closeLabel,
  resizeLabel,
  onClose,
  onResizeStart,
  onResizeBy,
  children,
}: ToolSidePanelProps) {
  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onResizeBy(event.key === 'ArrowLeft' ? 24 : -24);
  };

  return (
    <>
      {!isMobile ? (
        <div
          role="separator"
          tabIndex={0}
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={Math.round(minWidth)}
          aria-valuemax={Math.round(maxWidth)}
          aria-valuenow={Math.round(width)}
          onMouseDown={onResizeStart}
          onKeyDown={handleResizeKeyDown}
          className="group relative z-30 w-px shrink-0 cursor-col-resize bg-neutral-200 outline-none transition-colors hover:bg-neutral-400 focus:bg-blue-500 dark:bg-neutral-800 dark:hover:bg-neutral-600 dark:focus:bg-blue-400"
        >
          <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2" />
          <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 dark:bg-neutral-600" />
        </div>
      ) : null}

      <aside
        aria-label={title}
        className={
          isMobile
            ? 'absolute inset-0 z-40 flex min-h-0 flex-col bg-white shadow-2xl dark:bg-neutral-950'
            : 'flex min-h-0 shrink-0 flex-col bg-white dark:bg-neutral-950'
        }
        style={isMobile ? undefined : { width }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3.5 dark:border-neutral-800">
          <Icon className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </aside>
    </>
  );
}
