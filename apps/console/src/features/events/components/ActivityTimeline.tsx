import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
} from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import type { EventSeverity, RunEvent } from "../types";

export interface ActivityTimelineProps {
  events: RunEvent[];
  isLoading?: boolean;
  className?: string;
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toTimeString().split(" ")[0] ?? "";
  } catch {
    return "";
  }
}

function getSeverityIcon(severity: EventSeverity): React.ReactNode {
  switch (severity) {
    case "success":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    case "error":
      return <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    case "warn":
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    case "info":
    default:
      return <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
  }
}

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  events,
  isLoading = false,
  className,
}) => {
  const [severityFilter, setSeverityFilter] = React.useState<EventSeverity | "all">("all");
  const containerRef = React.useRef<HTMLDivElement>(null);

  const filteredEvents = React.useMemo(() => {
    if (severityFilter === "all") return events;
    return events.filter((e) => e.severity === severityFilter);
  }, [events, severityFilter]);

  // Auto-scroll to bottom on new event
  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events.length]);

  return (
    <section
      aria-labelledby="timeline-title"
      className={cn(
        "rounded-lg border border-border bg-surface flex flex-col overflow-hidden select-none",
        className
      )}
      data-testid="activity-timeline"
    >
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-foreground-muted" />
          <h2
            id="timeline-title"
            className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground-muted"
          >
            Activity Timeline ({events.length.toString()})
          </h2>
        </div>

        {/* Severity Filter buttons */}
        <div className="flex items-center gap-1 text-[11px] font-mono">
          {(["all", "info", "success", "error"] as const).map((sev) => (
            <button
              key={sev}
              type="button"
              onClick={() => { setSeverityFilter(sev); }}
              className={cn(
                "px-2 py-0.5 rounded transition-colors uppercase tracking-wider",
                severityFilter === sev
                  ? "bg-surface-hover text-white font-medium border border-border"
                  : "text-foreground-muted hover:text-foreground hover:bg-surface-raised"
              )}
            >
              {sev}
            </button>
          ))}
        </div>
      </div>

      {/* Events Stream */}
      <div
        ref={containerRef}
        className="divide-y divide-border-subtle max-h-80 overflow-y-auto font-mono text-xs"
        aria-live="polite"
      >
        {isLoading ? (
          <div className="p-4 text-center text-foreground-muted">Loading activity stream...</div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-6 text-center text-foreground-muted">
            {events.length === 0
              ? "No execution events recorded yet."
              : "No events match current filter."}
          </div>
        ) : (
          filteredEvents.map((event) => (
            <div
              key={event.id}
              className="p-2.5 px-4 flex items-start gap-3 hover:bg-surface-raised/40 transition-colors"
              data-testid={`event-item-${event.id}`}
            >
              {/* Monospace Timestamp */}
              <time
                dateTime={event.timestamp}
                className="text-[11px] text-foreground-muted/70 w-16 shrink-0 pt-0.5"
              >
                {formatTime(event.timestamp)}
              </time>

              {/* Severity Icon */}
              <div className="pt-0.5">{getSeverityIcon(event.severity)}</div>

              {/* Message & Context */}
              <div className="flex-1 min-w-0">
                <span className="text-foreground leading-relaxed">
                  {event.message}
                </span>

                {event.taskName ? (
                  <span className="ml-2 text-[10px] px-1.5 py-0.2 rounded bg-surface-raised text-foreground-muted border border-border-subtle inline-block">
                    {event.taskName}
                  </span>
                ) : null}

                {event.worker ? (
                  <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-surface-raised text-blue-400 border border-border-subtle inline-block">
                    {event.worker}
                  </span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
