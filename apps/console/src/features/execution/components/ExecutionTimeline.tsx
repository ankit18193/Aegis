import { Activity } from "lucide-react";
import * as React from "react";

import { ActivityTimeline } from "../../events/components/ActivityTimeline";
import type { ConnectionState, ExecutionStreamError, ExecutionStreamEvent } from "../stream/executionStream.types";

import { ConnectionStatus } from "./ConnectionStatus";

export interface ExecutionTimelineProps {
  readonly events: readonly ExecutionStreamEvent[];
  readonly connectionState?: ConnectionState;
  readonly error?: ExecutionStreamError | null;
  readonly isLoading?: boolean;
  readonly className?: string;
}

export const ExecutionTimeline: React.FC<ExecutionTimelineProps> = ({
  events,
  connectionState,
  error,
  isLoading = false,
  className,
}) => {
  return (
    <div className="space-y-3" data-testid="execution-timeline">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" />
          <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground-muted">
            Live Execution Stream ({events.length.toString()})
          </h2>
        </div>
        {connectionState ? (
          <ConnectionStatus status={connectionState} error={error} />
        ) : null}
      </div>

      <ActivityTimeline events={[...events]} isLoading={isLoading} className={className} />
    </div>
  );
};
