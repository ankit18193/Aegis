import * as React from "react";

import { cn } from "../../lib/utils/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", disabled, children, ...props }, ref) => {
    const baseStyles =
      "inline-flex items-center justify-center font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50 disabled:pointer-events-none select-none";

    const variants = {
      primary: "bg-accent hover:bg-accent-hover text-white shadow-sm",
      secondary: "bg-surface-raised hover:bg-surface-hover text-foreground border border-border",
      outline: "border border-border hover:bg-surface-hover text-foreground",
      ghost: "hover:bg-surface-hover text-foreground-muted hover:text-foreground",
      danger: "bg-danger hover:bg-red-600 text-white",
    };

    const sizes = {
      sm: "h-7 px-2.5 text-xs gap-1.5",
      md: "h-8 px-3 text-xs gap-2",
      lg: "h-10 px-4 text-sm gap-2",
    };

    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
