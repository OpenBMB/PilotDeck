import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type SettingsSectionProps = {
  // ReactNode so callers can inline a small icon next to the title (the
  // Permissions tab leans on this for its alert/shield glyphs).
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <div className={cn('space-y-3', className)}>
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
