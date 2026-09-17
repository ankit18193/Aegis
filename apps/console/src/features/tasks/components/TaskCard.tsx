import { ChevronRight, Cpu } from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import { StatusIndicator } from "../../runs/components/StatusIndicator";
import type { TaskSummary } from "../../runs/types";

export interface TaskCardProps {
  task: TaskSummary;
  index: number;
  isSelected?: boolean;
  onClick: (task: TaskSummary) => void;
  className?: string;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  index,
  isSelected = false,
  onClick,
  className,
}) => {
  return (
    <button
      type="button"
      onClick={() => { onClick(task); }}
      className={cn(
        "w-full text-left p-3.5 rounded-lg border transition-all flex items-center justify-between gap-4 group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        isSelected
          ? "bg-surface-raised border-accent/40 shadow-xs"
          : "bg-surface border-border hover:bg-surface-raised/60 hover:border-border",
        className
      )}
      data-testid={`task-card-${task.id}`}
      aria-expanded={isSelected}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className="text-xs font-mono text-foreground-muted/60 mt-0.5 w-5 shrink-0">
          {(index + 1).toString().padStart(2, "0")}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={cn(
                "text-xs font-semibold tracking-tight transition-colors",
                isSelected
                  ? "text-white"
                  : "text-foreground group-hover:text-white"
              )}
            >
              {task.name}
            </span>

            {task.worker ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-raised text-foreground-muted border border-border-subtle">
                <Cpu className="w-2.5 h-2.5" />
                <span>{task.worker}</span>
              </span>
            ) : null}

            {task.attemptCount > 1 ? (
              <span className="text-[10px] font-mono text-amber-400">
                (Attempt {task.attemptCount.toString()})
              </span>
            ) : null}
          </div>

          <p className="text-xs text-foreground-muted line-clamp-1">
            {task.description}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <StatusIndicator status={task.status} size="sm" />
        <ChevronRight className="w-4 h-4 text-foreground-muted/50 group-hover:text-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
};
