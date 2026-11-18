import type { ReactNode } from 'react';

import { cn } from './FormalHostPrimitives';

export type StatCardTone = 'default' | 'green' | 'red';

const SURFACE_CLASS: Record<StatCardTone, string> = {
  default: 'bg-[#f6f6f6]',
  green: 'bg-[#e9f7ef]',
  red: 'bg-[#fce7e7]',
};
const VALUE_CLASS: Record<StatCardTone, string> = {
  default: 'text-[#18181a]',
  green: 'text-[#2cb360]',
  red: 'text-[#d20b0b]',
};
const LABEL_CLASS: Record<StatCardTone, string> = {
  default: 'text-[#464c5e]',
  green: 'text-[#2cb360]',
  red: 'text-[#d20b0b]',
};

export type StatCardProps = {
  value: ReactNode;
  label: ReactNode;
  /** Colour accent. `default` = neutral grey card, `green`/`red` = tinted. */
  tone?: StatCardTone;
  /** Extra classes for the big value (e.g. a custom colour). */
  valueClassName?: string;
  /** Extra classes for the outer card (e.g. override the flex basis). */
  className?: string;
};

/**
 * Metric card used across the enterprise pages (定时任务 / 对话日志 / 技能 …):
 * a rounded tinted surface with a large value and a trailing label.
 */
export function StatCard({ value, label, tone = 'default', valueClassName, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'flex h-[70px] flex-1 basis-[180px] items-center rounded-[14px] px-[24px] py-[8px]',
        SURFACE_CLASS[tone],
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-[6px]">
        <span className={cn('shrink-0 text-[26px] font-semibold leading-none', VALUE_CLASS[tone], valueClassName)}>
          {value}
        </span>
        <span className={cn('truncate text-[14px] leading-none', LABEL_CLASS[tone])}>{label}</span>
      </div>
    </div>
  );
}

