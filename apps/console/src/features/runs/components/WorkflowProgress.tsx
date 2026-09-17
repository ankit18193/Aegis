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
import type { TaskStatus, TaskSummary } from "../types";

export interface WorkflowProgressProps {
  tasks: TaskSummary[];
  onTaskClick?: (task: TaskSummary) => void;
  selectedTaskId?: string;
  className?: string;
}

function getStepIcon(status: TaskStatus): React.ReactNode {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
    case "running":
      return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-rose-400" />;
    case "retrying":
      return <RotateCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />;
    case "cancelled":
      return <Ban className="w-3.5 h-3.5 text-foreground-muted" />;
    case "queued":
    case "pending":
    default:
      return <Clock className="w-3.5 h-3.5 text-foreground-muted/60" />;
  }
}

function getStepLineColor(status: TaskStatus): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/60";
    case "running":
      return "bg-accent";
    case "failed":
      return "bg-rose-500/60";
    default:
      return "bg-border";
  }
}

export const WorkflowProgress: React.FC<WorkflowProgressProps> = ({
  tasks,
  onTaskClick,
  selectedTaskId,
  className,
}) => {
  return (
    <div
      className={cn(
        "p-5 rounded-lg border border-border bg-surface select-none",
        className
      )}
      data-testid="workflow-progress"
      aria-label="Workflow step progress"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground-muted">
          Workflow Progression
        </h2>
        <span className="text-[11px] font-mono text-foreground-muted">
          Click any step to inspect
        </span>
      </div>

      <ol className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 relative">
        {tasks.map((task, idx) => {
          const isSelected = task.id === selectedTaskId;
          const isLast = idx === tasks.length - 1;

          return (
            <li
              key={task.id}
              className="flex-1 w-full md:w-auto flex flex-col md:items-center relative group"
            >
              {/* Connector line on desktop */}
              {!isLast ? (
                <div
                  className={cn(
                    "hidden md:block absolute top-4 left-1/2 w-full h-[2px] z-0 -translate-y-1/2 transition-colors",
                    getStepLineColor(task.status)
                  )}
                  aria-hidden="true"
                />
              ) : null}

              <button
                type="button"
                onClick={() => { onTaskClick?.(task); }}
                className={cn(
                  "relative z-10 w-full flex items-center md:flex-col gap-2 p-2 rounded-md transition-all text-left md:text-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                  isSelected
                    ? "bg-surface-raised border border-border"
                    : "hover:bg-surface-raised/50"
                )}
                aria-current={isSelected ? "step" : undefined}
                data-testid={`workflow-step-${task.id}`}
              >
                {/* Icon Badge */}
                <div
                  className={cn(
                    "w-7 h-7 rounded-full flex items-center justify-center border shrink-0 transition-colors",
                    task.status === "completed"
                      ? "bg-emerald-950/40 border-emerald-500/30"
                      : task.status === "running"
                        ? "bg-blue-950/40 border-blue-500/40 shadow-xs shadow-blue-500/10"
                        : task.status === "failed"
                          ? "bg-rose-950/40 border-rose-500/30"
                          : "bg-surface-raised border-border text-foreground-muted"
                  )}
                >
                  {getStepIcon(task.status)}
                </div>

                {/* Step Info */}
                <div className="flex-1 min-w-0 md:w-full">
                  <span className="block text-[10px] font-mono text-foreground-muted uppercase tracking-wider">
                    Step {(idx + 1).toString()}
                  </span>
                  <span
                    className={cn(
                      "block text-xs font-medium truncate mt-0.5",
                      isSelected
                        ? "text-white"
                        : "text-foreground-muted group-hover:text-foreground"
                    )}
                    title={task.name}
                  >
                    {task.name}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
