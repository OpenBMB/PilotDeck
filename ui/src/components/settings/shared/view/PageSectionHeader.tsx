import type { ReactNode } from "react";
import { cn } from "../../../../lib/utils";

type PageSectionHeaderProps = {
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
};

export default function PageSectionHeader({
  title,
  description,
  className,
}: PageSectionHeaderProps) {
  if (!title && !description) return null;

  return (
    <div className={cn("space-y-1.5", className)}>
      {title ? (
        <h3 className="text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
          {title}
        </h3>
      ) : null}
      {description ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}
