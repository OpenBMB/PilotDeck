import type { ReactNode } from "react";
import { cn } from "../../../../lib/utils";

type SettingsRowProps = {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function SettingsRow({
  label,
  description,
  children,
  className,
}: SettingsRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-3", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-5 text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
