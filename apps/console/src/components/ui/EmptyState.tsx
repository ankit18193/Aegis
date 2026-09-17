import type { LucideIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/utils/cn";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className,
}) => {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center max-w-sm mx-auto",
        className
      )}
      data-testid="empty-state"
    >
      {Icon ? (
        <div className="w-10 h-10 rounded-full bg-surface-raised border border-border flex items-center justify-center text-foreground-muted mb-3">
          <Icon className="w-5 h-5" />
        </div>
      ) : null}
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description ? (
        <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
};
