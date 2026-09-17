import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import type { Run } from "../types";

export interface RunProgressProps {
  run: Run;
  className?: string;
}

export const RunProgress: React.FC<RunProgressProps> = ({ run, className }) => {
  const totalTasks = run.tasks.length;
  const completedTasks = run.tasks.filter((t) => t.status === "completed").length;

  const isFailed = run.status === "failed";
  const isCompleted = run.status === "completed";

  const barColor = isFailed
    ? "bg-rose-500"
    : isCompleted
      ? "bg-emerald-500"
      : "bg-accent";

  return (
    <div
      className={cn(
        "p-4 px-6 border-b border-border bg-surface-raised/40 select-none",
        className
      )}
      data-testid="run-progress-container"
    >
      <div className="flex items-center justify-between text-xs font-mono mb-2">
        <span className="text-foreground-muted">
          Workflow Execution:{" "}
          <strong className="text-foreground font-semibold">
            {completedTasks.toString()} of {totalTasks.toString()} tasks completed
          </strong>
        </span>
        <span className="font-semibold text-foreground" data-testid="run-progress-percentage">
          {run.progress.toString()}%
        </span>
      </div>

      <div
        className="w-full bg-border rounded-full h-1.5 overflow-hidden"
        role="progressbar"
        aria-valuenow={run.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Workflow execution progress"
      >
        <div
          className={cn("h-full transition-all duration-300 ease-out", barColor)}
          style={{ width: `${run.progress.toString()}%` }}
        />
      </div>
    </div>
  );
};
