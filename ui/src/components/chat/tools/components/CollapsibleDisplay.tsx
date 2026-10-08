import React from 'react';
import { CollapsibleSection } from './CollapsibleSection';

interface CollapsibleDisplayProps {
  toolName: string;
  toolId?: string;
  title: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  action?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  className?: string;
  toolCategory?: string;
  autoExpandable?: boolean;
}

export const CollapsibleDisplay: React.FC<CollapsibleDisplayProps> = ({
  toolName,
  title,
  defaultOpen = false,
  open,
  onOpenChange,
  action,
  onTitleClick,
  children,
  className = '',
  autoExpandable = true
}) => {
  return (
    <div className={`my-1 min-w-0 py-0.5 ${className}`}>
      <CollapsibleSection
        title={title}
        toolName={toolName}
        open={open ?? defaultOpen}
        onOpenChange={onOpenChange}
        action={action}
        onTitleClick={onTitleClick}
        autoExpandable={autoExpandable}
      >
        {children}
      </CollapsibleSection>
    </div>
  );
};
