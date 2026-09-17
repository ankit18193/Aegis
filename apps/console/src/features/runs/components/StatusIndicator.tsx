import {
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  RotateCw,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import type { RunStatus, TaskStatus } from "../types";

export type StatusType = RunStatus | TaskStatus;

interface StatusConfig {
  label: string;
  badgeVariant: "default" | "success" | "warning" | "danger" | "info" | "neutral";
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  textColor: string;
  isSpinning?: boolean;
}

export const STATUS_CONFIG: Record<StatusType, StatusConfig> = {
  pending: {
    label: "Pending",
    badgeVariant: "neutral",
    icon: Clock,
    iconColor: "text-foreground-muted",
    textColor: "text-foreground-muted",
  },
  queued: {
    label: "Queued",
    badgeVariant: "neutral",
    icon: Clock,
    iconColor: "text-blue-400",
    textColor: "text-blue-400",
  },
  running: {
    label: "Running",
    badgeVariant: "info",
    icon: Loader2,
    iconColor: "text-blue-400",
    textColor: "text-blue-400",
    isSpinning: true,
  },
  completed: {
    label: "Completed",
    badgeVariant: "success",
    icon: CheckCircle2,
    iconColor: "text-emerald-400",
    textColor: "text-emerald-400",
  },
  failed: {
    label: "Failed",
    badgeVariant: "danger",
    icon: XCircle,
    iconColor: "text-rose-400",
    textColor: "text-rose-400",
  },
  retrying: {
    label: "Retrying",
    badgeVariant: "warning",
    icon: RotateCw,
    iconColor: "text-amber-400",
    textColor: "text-amber-400",
    isSpinning: true,
  },
  cancelled: {
    label: "Cancelled",
    badgeVariant: "neutral",
    icon: Ban,
    iconColor: "text-foreground-muted",
    textColor: "text-foreground-muted",
  },
};

export interface StatusIndicatorProps {
  status: StatusType;
  showText?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  showText = true,
  size = "sm",
  className,
}) => {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  const iconSizes = {
    sm: "w-3.5 h-3.5",
    md: "w-4 h-4",
  };

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 select-none", className)}
      role="status"
      aria-label={`Status: ${config.label}`}
    >
      <Icon
        className={cn(
          iconSizes[size],
          config.iconColor,
          config.isSpinning && "animate-spin"
        )}
        aria-hidden="true"
      />
      {showText ? (
        <span className={cn("text-xs font-mono font-medium", config.textColor)}>
          {config.label}
        </span>
      ) : null}
    </span>
  );
};
