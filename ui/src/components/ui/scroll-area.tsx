import * as React from 'react';
import { cn } from '../../lib/utils.js';

// Lightweight scroll container that matches the shadcn <ScrollArea> API surface
// enough for our current callsites. We intentionally don't pull in
// @radix-ui/react-scroll-area yet — the real one has SSR quirks and we don't
// need overlay scrollbars for V2-shell work. Swap to Radix in a later PR if
// we ever need cross-OS styled scrollbars.
export type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement>;

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'relative overflow-y-auto overflow-x-hidden scrollbar-thin',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';

export { ScrollArea };
