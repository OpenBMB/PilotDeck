import { useRef, type ReactNode } from 'react';
import { useScrollFollow } from '../chat/hooks/useScrollFollow';

export function StreamingScrollViewport({ children, label, enabled = true, className = '' }: {
  children: ReactNode;
  label: string;
  enabled?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { hasOverflow } = useScrollFollow({ containerRef, enabled });
  return (
    <div
      ref={containerRef}
      data-stream-scroll-viewport
      role="region"
      tabIndex={0}
      aria-label={label}
      className={`max-h-64 overflow-y-auto ${hasOverflow ? 'overscroll-y-contain' : ''} outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${className}`}
      style={{ overflowAnchor: 'none' }}
    >
      <div>{children}</div>
    </div>
  );
}
