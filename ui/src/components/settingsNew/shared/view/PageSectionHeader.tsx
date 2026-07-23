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
    <div className={cn("space-y-2", className)}>
      {title ? <h3 className="text-xl font-semibold text-foreground">{title}</h3> : null}
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}
