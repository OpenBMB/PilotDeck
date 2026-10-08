import { File } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { getFileIconData } from '../constants/fileIcons';

type FileTypeIconProps = {
  filename: string;
  mimeType?: string;
  className?: string;
  assetClassName?: string;
  strokeWidth?: number;
};

export function FileTypeIcon({
  filename,
  mimeType,
  className,
  assetClassName,
  strokeWidth = 1.75,
}: FileTypeIconProps) {
  const iconData = getFileIconData(filename, mimeType);
  if (iconData.category === 'code') {
    // Inline paths let the file glyph inherit the selected light palette.
    return <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true"
      className={cn('shrink-0', className, assetClassName)} fill="none"
      stroke="var(--pd-accent-strong, #7c3aed)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 3.5h16l9 9v29a3 3 0 0 1-3 3h-22a3 3 0 0 1-3-3v-35a3 3 0 0 1 3-3Z" fill="var(--pd-accent-soft, #f5f3ff)" />
      <path d="M29.5 3.5v7a2 2 0 0 0 2 2h7" />
      <g transform="translate(24 22) scale(1.28) translate(-24 -22)" strokeWidth="1.65">
        <path d="m21.5 16.5-4 4 4 4M26.5 16.5l4 4-4 4M25.5 15.5l-3 10" />
      </g>
      <path d="M18 34.5h12" strokeWidth="2.4" opacity=".28" />
    </svg>;
  }
  if (iconData.asset) {
    return (
      <img
        src={iconData.asset}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('shrink-0 object-contain', className, assetClassName)}
      />
    );
  }

  const Icon = iconData.icon || File;
  return (
    <Icon
      aria-hidden="true"
      className={cn('shrink-0', iconData.color, className)}
      strokeWidth={strokeWidth}
    />
  );
}
