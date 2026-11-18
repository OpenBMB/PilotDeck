
export type BadgeTone = 'blue' | 'orange' | 'green' | 'red' | 'gray';
export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  blue: 'bg-[#e8f0ff] text-[#1a71ff]',
  orange: 'bg-[#fff2e5] text-[#ff7f00]',
  green: 'bg-[#e9f7ef] text-[#2cb360]',
  red: 'bg-[#fce7e7] text-[#d20b0b]',
  gray: 'bg-[#f2f3f7] text-[#858b9c]',
};
import type { ReactNode } from 'react';

import { cn } from './FormalHostPrimitives';



export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[12px] py-[4px] text-[10px] leading-none whitespace-nowrap capitalize',
        BADGE_TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}
