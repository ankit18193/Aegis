import { ListOrdered, Search } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "../../../components/ui/EmptyState";
import { cn } from "../../../lib/utils/cn";
import { formatRelativeTime, truncate } from "../../../lib/utils/formatters";
import type { RunListItem } from "../types";

import { StatusIndicator } from "./StatusIndicator";

export interface RunsSidebarProps {
  runs: RunListItem[];
  isLoading?: boolean;
  onNewRunClick?: () => void;
  className?: string;
}

export const RunsSidebar: React.FC<RunsSidebarProps> = ({
  runs,
  isLoading = false,
  className,
}) => {
  const { runId: activeRunId } = useParams<{ runId: string }>();
  const [filterQuery, setFilterQuery] = React.useState("");

  const filteredRuns = React.useMemo(() => {
    if (!filterQuery.trim()) return runs;
    const q = filterQuery.toLowerCase();
    return runs.filter(
      (run) =>
        run.goal.toLowerCase().includes(q) ||
        run.id.toLowerCase().includes(q) ||
        run.status.toLowerCase().includes(q)
    );
  }, [runs, filterQuery]);

  return (
    <aside
      className={cn(
        "w-72 md:w-80 border-r border-border bg-surface flex flex-col shrink-0 h-full select-none",
        className
      )}
      aria-label="Runs navigation"
      data-testid="runs-sidebar"
    >
      {/* Sidebar Header */}
      <div className="p-3 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted font-mono">
            Recent Runs
          </span>
          <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-surface-raised text-foreground-muted border border-border-subtle">
            {runs.length}
          </span>
        </div>
      </div>

      {/* Filter / Search input */}
      {runs.length > 0 ? (
        <div className="p-2 border-b border-border-subtle">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 absolute left-2.5 text-foreground-muted pointer-events-none" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => { setFilterQuery(e.target.value); }}
              placeholder="Filter runs..."
              aria-label="Filter runs"
              className="w-full bg-surface-raised text-xs text-foreground placeholder:text-foreground-muted pl-8 pr-3 py-1.5 rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
          </div>
        </div>
      ) : null}

      {/* Runs List */}
      <div className="flex-1 overflow-y-auto divide-y divide-border-subtle">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 rounded bg-surface-raised animate-pulse border border-border-subtle"
              />
            ))}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="py-12 px-4">
            <EmptyState
              icon={ListOrdered}
              title={runs.length === 0 ? "No runs found" : "No matching runs"}
              description={
                runs.length === 0
                  ? "Start an agent execution by clicking '+ New Run' above."
                  : "Try clearing your filter search."
              }
            />
          </div>
        ) : (
          <nav aria-label="Runs list" className="divide-y divide-border-subtle">
            {filteredRuns.map((run) => {
              const isActive = run.id === activeRunId;
              return (
                <Link
                  key={run.id}
                  to={`/runs/${run.id}`}
                  aria-current={isActive ? "page" : undefined}
                  data-testid={`run-item-${run.id}`}
                  className={cn(
                    "block p-3 transition-colors text-left relative group",
                    isActive
                      ? "bg-surface-raised text-white"
                      : "hover:bg-surface-hover text-foreground-muted hover:text-foreground"
                  )}
                >
                  {/* Active Indicator Bar */}
                  {isActive ? (
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-accent" />
                  ) : null}

                  {/* Top Row: Goal */}
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p
                      className={cn(
                        "text-xs font-medium leading-snug line-clamp-2",
                        isActive ? "text-foreground" : "text-foreground-muted group-hover:text-foreground"
                      )}
                      title={run.goal}
                    >
                      {truncate(run.goal, 68)}
                    </p>
                  </div>

                  {/* Bottom Row: Status + Timestamp */}
                  <div className="flex items-center justify-between text-[11px] font-mono mt-2">
                    <StatusIndicator status={run.status} size="sm" />
                    <time
                      dateTime={run.createdAt}
                      className="text-foreground-muted"
                      title={new Date(run.createdAt).toLocaleString()}
                    >
                      {formatRelativeTime(run.createdAt)}
                    </time>
                  </div>

                  {/* Progress Line */}
                  {run.status === "running" ? (
                    <div className="w-full bg-border-subtle h-0.5 mt-2 rounded overflow-hidden">
                      <div
                        className="bg-accent h-full transition-all duration-300"
                        style={{ width: `${run.progress.toString()}%` }}
                      />
                    </div>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </aside>
  );
};
