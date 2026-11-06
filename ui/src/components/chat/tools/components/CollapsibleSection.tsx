import React, { useEffect, useId, useState } from 'react';
import { AnimatedDisclosure } from '../../../ui/AnimatedDisclosure';

interface CollapsibleSectionProps {
  title: string;
  toolName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  action?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  className?: string;
  autoExpandable?: boolean;
}

/**
 * Reusable collapsible section with consistent styling
 */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  toolName,
  open = false,
  onOpenChange,
  action,
  onTitleClick,
  children,
  className = '',
  autoExpandable = true,
}) => {
  const contentId = useId();
  const [local, setLocal] = useState({ source: open, expanded: open });
  if (local.source !== open) setLocal({ source: open, expanded: open });
  const expanded = onOpenChange ? open : local.source === open ? local.expanded : open;
  const [nativeOpen, setNativeOpen] = useState(open);
  useEffect(() => {
    if (expanded) { setNativeOpen(true); return; }
    if (!nativeOpen) return;
    const timer = window.setTimeout(() => setNativeOpen(false), 240);
    return () => window.clearTimeout(timer);
  }, [expanded, nativeOpen]);
  const toggle = (value: boolean) => { setLocal({ source: open, expanded: value }); onOpenChange?.(value); };
  return (
    <details
      className={`group/details relative ${className}`}
      open={nativeOpen || expanded}
      onToggle={event => {
        // Preserve the existing global auto-expand consumer of native details.
        if (event.currentTarget.open && !nativeOpen && !expanded) toggle(true);
      }}
      data-auto-expand={autoExpandable ? undefined : 'false'}
    >
      <summary
        aria-expanded={expanded} aria-controls={contentId}
        onClick={event => {
          const interactiveTarget = (event.target as HTMLElement).closest('button, a, input, select, textarea');
          if (interactiveTarget && interactiveTarget !== event.currentTarget) return;
          event.preventDefault(); toggle(!expanded);
        }}
        className="flex cursor-pointer select-none items-center gap-2 py-0.5 text-[13px] group-open/details:sticky group-open/details:top-0 group-open/details:z-10 group-open/details:-mx-1 group-open/details:bg-background group-open/details:px-1"
      >
        <svg
          className={`h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none dark:text-gray-500 ${expanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {toolName && (
          <span className="flex-shrink-0 font-medium text-gray-500 dark:text-gray-400">{toolName}</span>
        )}
        {toolName && (
          <span className="flex-shrink-0 text-[10px] text-gray-300 dark:text-gray-600">/</span>
        )}
        {onTitleClick ? (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTitleClick(); }}
            className="flex-1 truncate text-left font-mono text-[var(--pd-accent-strong,#2563eb)] transition-colors hover:text-[var(--pd-accent-strong,#1d4ed8)] hover:underline dark:text-[var(--pd-accent-strong,#60a5fa)] dark:hover:text-[var(--pd-accent-strong,#93c5fd)]"
          >
            {title}
          </button>
        ) : (
          <span className="flex-1 truncate text-gray-600 dark:text-gray-400">
            {title}
          </span>
        )}
        {action && <span className="ml-1 flex-shrink-0">{action}</span>}
      </summary>
      <AnimatedDisclosure id={contentId} expanded={expanded} keepMounted contentClassName="ml-[22px] mt-2">
        {children}
      </AnimatedDisclosure>
    </details>
  );
};
