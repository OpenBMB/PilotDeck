import type { ReactNode } from 'react';

import { cn } from './FormalHostPrimitives';

export type DetailFieldProps = {
  label: string;
  children: ReactNode;
  className?: string;
};

/**
 * Labelled read-only field used inside detail dialogs (员工记忆 / 对话日志 /
 * SOP 版本详情 …): a bordered light card with an 11px caption and its value.
 */
export function DetailField({ label, children, className }: DetailFieldProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-[6px] rounded-[10px] border border-[#eef0f4] bg-[#fafbfc] px-[12px] py-[10px]',
        className,
      )}
    >
      <span className="text-[11px] font-semibold text-[#858b9c]">{label}</span>
      <div className="min-w-0 wrap-break-word text-[12px] text-[#18181a]">{children}</div>
    </div>
  );
}

