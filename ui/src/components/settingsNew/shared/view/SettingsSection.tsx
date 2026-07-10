import type { ReactNode } from "react";
import { cn } from "../../../../lib/utils";

type SettingsSectionProps = {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function SettingsSection({
  title,
  description,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <div className={cn("space-y-2.5", className)}>
      <div>
        {title ? (
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h3>
        ) : null}
        {description && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
