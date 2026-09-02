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
