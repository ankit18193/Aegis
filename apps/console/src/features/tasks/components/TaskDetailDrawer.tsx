import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Cpu,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import * as React from "react";

import { StatusIndicator } from "../../runs/components/StatusIndicator";
import type { TaskSummary } from "../../runs/types";

export interface TaskDetailDrawerProps {
  task: TaskSummary | null;
  onClose: () => void;
}

export const TaskDetailDrawer: React.FC<TaskDetailDrawerProps> = ({
  task,
  onClose,
}) => {
  // Close on Escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    if (task) {
      window.addEventListener("keydown", handleKeyDown);
      return () => { window.removeEventListener("keydown", handleKeyDown); };
    }
    return undefined;
  }, [task, onClose]);

  if (!task) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50 backdrop-blur-xs select-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-detail-title"
      data-testid="task-detail-drawer"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-surface border-l border-border h-full flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200"
        onClick={(e) => { e.stopPropagation(); }}
      >
        {/* Drawer Header */}
        <div className="p-5 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-foreground-muted bg-surface-raised px-2 py-0.5 rounded border border-border-subtle">
              {task.id}
            </span>
            <StatusIndicator status={task.status} size="sm" />
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-foreground-muted hover:text-foreground p-1 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-accent"
            aria-label="Close task details"
            data-testid="close-task-drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <div>
            <h3
              id="task-detail-title"
              className="text-base font-semibold text-foreground tracking-tight"
            >
              {task.name}
            </h3>
            <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
              {task.description}
            </p>
          </div>

          {/* Execution Metadata Table */}
          <div className="rounded-lg border border-border bg-surface-raised/50 divide-y divide-border-subtle text-xs font-mono">
            <div className="flex items-center justify-between p-3">
              <span className="text-foreground-muted flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-foreground-muted/70" />
                <span>Assigned Worker</span>
              </span>
              <span className="text-foreground font-medium">
                {task.worker ?? "Unassigned (Pending Queue)"}
              </span>
            </div>

            <div className="flex items-center justify-between p-3">
              <span className="text-foreground-muted flex items-center gap-1.5">
                <RotateCw className="w-3.5 h-3.5 text-foreground-muted/70" />
                <span>Execution Attempts</span>
              </span>
              <span className="text-foreground font-medium">
                {task.attemptCount.toString()}
              </span>
            </div>

            {task.startedAt ? (
              <div className="flex items-center justify-between p-3">
                <span className="text-foreground-muted flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-foreground-muted/70" />
                  <span>Started At</span>
                </span>
                <span className="text-foreground">
                  {new Date(task.startedAt).toLocaleTimeString()}
                </span>
              </div>
            ) : null}

            {task.completedAt ? (
              <div className="flex items-center justify-between p-3">
                <span className="text-foreground-muted flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-foreground-muted/70" />
                  <span>Completed At</span>
                </span>
                <span className="text-foreground">
                  {new Date(task.completedAt).toLocaleTimeString()}
                </span>
              </div>
            ) : null}
          </div>

          {/* Error Output Section */}
          {task.error ? (
            <div>
              <div className="flex items-center gap-2 mb-2 text-rose-400 text-xs font-mono font-medium">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Error Log</span>
              </div>
              <pre className="p-3.5 rounded-lg bg-rose-950/20 border border-rose-500/30 text-rose-300 font-mono text-xs whitespace-pre-wrap leading-relaxed overflow-x-auto">
                {task.error}
              </pre>
            </div>
          ) : null}

          {/* Task Output Section */}
          {task.output ? (
            <div>
              <div className="flex items-center gap-2 mb-2 text-foreground-muted text-xs font-mono font-medium">
                <Terminal className="w-3.5 h-3.5" />
                <span>Execution Output</span>
              </div>
              <pre className="p-3.5 rounded-lg bg-surface-raised border border-border text-emerald-300 font-mono text-xs whitespace-pre-wrap leading-relaxed overflow-x-auto">
                {task.output}
              </pre>
            </div>
          ) : null}

          {!task.error && !task.output && (
            <div className="p-6 text-center text-xs font-mono text-foreground-muted border border-dashed border-border-subtle rounded-lg">
              No execution output logged for this task yet.
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="p-4 border-t border-border bg-surface-raised flex items-center justify-between shrink-0 text-xs font-mono text-foreground-muted">
          <span>Aegis Worker Task Inspector</span>
          <span className="flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-accent" />
            <span>Telemetry verified</span>
          </span>
        </div>
      </div>
    </div>
  );
};
