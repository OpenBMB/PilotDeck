import type { ReactNode } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export default function SidebarSectionHeading({
  title,
  expanded,
  expandLabel,
  collapseLabel,
  actionLabel,
  actionIcon,
  onAction,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  expandLabel: string;
  collapseLabel: string;
  actionLabel?: string;
  actionIcon?: ReactNode;
  onAction?: () => void;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const toggleLabel = expanded ? collapseLabel : expandLabel;
  return (
    <div className="tree-heading shrink-0">
      <span className="min-w-0 truncate">{title}</span>
      <div className="tree-heading-actions shrink-0">
        {children}
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            aria-label={actionLabel}
            title={actionLabel}
          >
            {actionIcon ?? (
              <MessageSquarePlus aria-hidden="true" className="icon" size={15} strokeWidth={1.8} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <svg
            aria-hidden="true"
            className={cn('icon transition-transform', !expanded && '-rotate-90')}
            fill="none"
            height="15"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="15"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
