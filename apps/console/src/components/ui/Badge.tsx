import * as React from "react";

import { cn } from "../../lib/utils/cn";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "danger" | "info" | "neutral";
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = "default",
  children,
  ...props
}) => {
  const baseStyles =
    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium font-mono uppercase tracking-wider select-none";

  const variants = {
    default: "bg-surface-hover text-foreground-muted border border-border",
    neutral: "bg-surface-raised text-foreground-muted border border-border-subtle",
    success: "bg-success-subtle text-emerald-400 border border-emerald-500/20",
    warning: "bg-warning-subtle text-amber-400 border border-amber-500/20",
    danger: "bg-danger-subtle text-rose-400 border border-rose-500/20",
    info: "bg-blue-950/40 text-blue-400 border border-blue-500/20",
  };

  return (
    <span className={cn(baseStyles, variants[variant], className)} {...props}>
      {children}
    </span>
  );
};
