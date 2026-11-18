import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Original frontend-enterprise/src/lib/utils.ts class merging contract.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
