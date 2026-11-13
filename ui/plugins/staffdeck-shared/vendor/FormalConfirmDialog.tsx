import type { ReactNode } from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './FormalHostPrimitives';
import { Button } from './FormalHostPrimitives';
import { cn } from './FormalHostPrimitives';

import { IconWarningFill } from './FormalHostPrimitives';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Header title. Supports rich content (e.g. the target name in a `<strong>`). */
  title: ReactNode;
  /** Optional supporting copy shown below the title. */
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  /** When true, buttons are disabled and closing via overlay/esc is blocked. */
  loading?: boolean;
  /** Destructive (red) confirm button. Defaults to true — matches the delete flow. */
  destructive?: boolean;
  /** Override the leading header icon. Pass `null` to hide it. */
  icon?: ReactNode;
};

/**
 * Confirmation popup matching the SD1 design (node 281:5153): a warning icon +
 * title header, a muted description, and a right-aligned cancel / confirm footer.
 * Built on the Radix `AlertDialog` primitives so focus trapping and a11y are handled.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '删除',
  cancelText = '取消',
  onConfirm,
  loading = false,
  destructive = true,
  icon,
}: ConfirmDialogProps) {
  const leadingIcon =
    icon === undefined ? (
      <IconWarningFill className="mt-px size-[16px] shrink-0 text-[#ff7f00]" />
    ) : (
      icon
    );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (loading && !next) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className="gap-0 overflow-hidden rounded-[16px] p-0">
        <div className="flex items-start gap-[8px] px-[16px] pt-[16px] pb-[12px]">
          {leadingIcon}
          <AlertDialogTitle className="min-w-0 flex-1 text-[14px] leading-[normal] font-medium text-[#18181a] [word-break:break-word]">
            {title}
          </AlertDialogTitle>
        </div>
        {description != null && (
          <div className="px-[24px] pb-[12px]">
            <AlertDialogDescription className="text-[14px] leading-[20px] text-[#4f5669] [word-break:break-word]">
              {description}
            </AlertDialogDescription>
          </div>
        )}
        <div className="flex items-center justify-end gap-[8px] pt-[12px] pr-[16px] pb-[16px] pl-[12px]">
          <AlertDialogPrimitive.Cancel asChild>
            <Button
              variant="outline"
              disabled={loading}
              className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] py-[8px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
            >
              {cancelText}
            </Button>
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action asChild>
            <Button
              disabled={loading}
              className={cn(
                'h-[32px] w-[80px] rounded-[10px] px-[12px] py-[8px] text-[14px] font-normal',
                destructive
                  ? 'bg-[#d20b0b] text-white hover:bg-[#b80909]'
                  : 'bg-[#18181a] text-white hover:bg-[#303030]',
              )}
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                onConfirm();
              }}
            >
              {confirmText}
            </Button>
          </AlertDialogPrimitive.Action>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
