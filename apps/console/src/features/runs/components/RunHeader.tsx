import { Calendar, Clock } from "lucide-react";
import * as React from "react";

import { formatRelativeTime } from "../../../lib/utils/formatters";
import type { Run } from "../types";

import { StatusIndicator } from "./StatusIndicator";

export interface RunHeaderProps {
  run: Run;
  actions?: React.ReactNode;
}

export const RunHeader: React.FC<RunHeaderProps> = ({ run, actions }) => {
  return (
    <header
      className="p-6 border-b border-border bg-surface select-none"
      data-testid="run-header"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Goal Title & Metadata */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <span className="text-xs font-mono text-foreground-muted bg-surface-raised px-2 py-0.5 rounded border border-border-subtle">
              {run.id}
            </span>
            <StatusIndicator status={run.status} size="md" />
          </div>

          <h1
            className="text-lg md:text-xl font-semibold text-foreground tracking-tight leading-snug break-words"
            data-testid="run-goal-title"
          >
            {run.goal}
          </h1>

          <div className="flex items-center gap-4 mt-3 text-xs font-mono text-foreground-muted">
            <span className="flex items-center gap-1.5" title={new Date(run.createdAt).toLocaleString()}>
              <Calendar className="w-3.5 h-3.5 text-foreground-muted/70" />
              <span>Created {formatRelativeTime(run.createdAt)}</span>
            </span>
            <span className="text-border-subtle">•</span>
            <span className="flex items-center gap-1.5" title={new Date(run.updatedAt).toLocaleString()}>
              <Clock className="w-3.5 h-3.5 text-foreground-muted/70" />
              <span>Updated {formatRelativeTime(run.updatedAt)}</span>
            </span>
          </div>
        </div>

        {/* Action Toolbar */}
        {actions ? (
          <div className="flex items-center gap-2 shrink-0 self-start md:self-center">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
};
