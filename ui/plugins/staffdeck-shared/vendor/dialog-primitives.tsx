import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { Button } from '../../../src/components/ui/button';
import { cn } from '../../../src/lib/utils';
import './knowledge-host-theme.css';

// Formal primitive port from StaffDeck frontend-enterprise/src/components/ui/dialog.tsx
// at e83c347d. Root/Portal/Overlay/Content/Title keep Radix's controlled,
// focus, ref and prop contracts, including the original Escape prevention.
// Only host imports, the local palette marker and the native Button size name
// differ. The shared business pages still render their original dialogs.
export function PilotDeckDialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay ref={ref} data-slot="dialog-overlay" className={cn(
    'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0', className,
  )} {...props} />;
});

export const PilotDeckDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }
>(function PilotDeckDialogContent({ className, children, showCloseButton = true, onEscapeKeyDown, ...props }, ref) {
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} data-slot="dialog-content" data-staffdeck-portal-root="true" onEscapeKeyDown={(event) => {
      event.preventDefault();
      onEscapeKeyDown?.(event);
    }} className={cn(
      'pilotdeck-business-dialog fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95', className,
    )} {...props}>
      {children}
      {showCloseButton && <DialogPrimitive.Close data-slot="dialog-close" asChild>
        <Button variant="ghost" size="icon" className="absolute top-2 right-2 h-7 w-7 text-[#858b9c] hover:bg-[#f2f3f7] hover:text-[#18181a]">
          <XIcon /><span className="sr-only">Close</span>
        </Button>
      </DialogPrimitive.Close>}
    </DialogPrimitive.Content>
  </DialogPortal>;
});

export const PilotDeckDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function PilotDeckDialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn('font-heading text-base leading-none font-medium', className)} {...props} />;
});
