import { AlertCircle, Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import type { ConnectionState, ExecutionStreamError } from "../stream/executionStream.types";

export interface ConnectionStatusProps {
  readonly status: ConnectionState;
  readonly error?: ExecutionStreamError | null;
  readonly className?: string;
}

export const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  status,
  error,
  className,
}) => {
  const config = React.useMemo(() => {
    switch (status) {
      case "connected":
        return {
          label: "Live Stream",
          dotColor: "bg-emerald-500",
          textColor: "text-emerald-400",
          borderColor: "border-emerald-500/20",
          icon: <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>,
        };
      case "connecting":
        return {
          label: "Connecting...",
          dotColor: "bg-amber-500",
          textColor: "text-amber-400",
          borderColor: "border-amber-500/20",
          icon: <Loader2 className="w-3 h-3 animate-spin text-amber-400" />,
        };
      case "error":
        return {
          label: error ? `Error: ${error.code}` : "Stream Error",
          dotColor: "bg-rose-500",
          textColor: "text-rose-400",
          borderColor: "border-rose-500/30",
          icon: <AlertCircle className="w-3 h-3 text-rose-400" />,
        };
      case "disconnected":
      default:
        return {
          label: "Offline",
          dotColor: "bg-foreground-muted/40",
          textColor: "text-foreground-muted",
          borderColor: "border-border-subtle",
          icon: <span className="inline-block w-2 h-2 rounded-full bg-foreground-muted/40" />,
        };
    }
  }, [status, error]);

  return (
    <div
      role="status"
      aria-label={`Execution stream status: ${config.label}`}
      className={cn(
        "inline-flex items-center gap-2 px-2.5 py-1 rounded text-xs font-mono bg-surface-raised border transition-colors",
        config.borderColor,
        className,
      )}
      data-testid="connection-status-badge"
      data-status={status}
    >
      {config.icon}
      <span className={cn("font-medium", config.textColor)}>
        {config.label}
      </span>
    </div>
  );
};
