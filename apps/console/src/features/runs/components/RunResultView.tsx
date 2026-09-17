import { CheckCircle2, FileText } from "lucide-react";
import * as React from "react";

import { cn } from "../../../lib/utils/cn";
import type { RunResult } from "../types";

export interface RunResultViewProps {
  result: RunResult;
  className?: string;
}

export const RunResultView: React.FC<RunResultViewProps> = ({
  result,
  className,
}) => {
  return (
    <section
      aria-labelledby="result-section-title"
      className={cn(
        "rounded-lg border border-emerald-500/30 bg-surface overflow-hidden shadow-xs select-none",
        className
      )}
      data-testid="run-result-view"
    >
      {/* Header */}
      <div className="p-4 border-b border-border bg-emerald-950/20 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <h2
            id="result-section-title"
            className="text-xs font-mono font-semibold uppercase tracking-wider text-emerald-300"
          >
            Execution Result
          </h2>
        </div>

        {result.metrics ? (
          <div className="flex items-center gap-3 text-xs font-mono text-foreground-muted">
            <span>
              Duration:{" "}
              <strong className="text-foreground">
                {(result.metrics.durationMs / 1000).toFixed(1)}s
              </strong>
            </span>
            <span>•</span>
            <span>
              Tasks:{" "}
              <strong className="text-foreground">
                {result.metrics.tasksCompleted.toString()} / {result.metrics.tasksTotal.toString()}
              </strong>
            </span>
          </div>
        ) : null}
      </div>

      {/* Main Result Body */}
      <div className="p-6 space-y-4">
        {/* Executive Summary */}
        <div>
          <h3 className="text-xs font-mono font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
            Summary
          </h3>
          <p className="text-sm text-foreground leading-relaxed">
            {result.summary}
          </p>
        </div>

        {/* Detailed Output / Report */}
        {result.reportMarkdown ? (
          <div>
            <h3 className="text-xs font-mono font-semibold text-foreground-muted uppercase tracking-wider mb-2">
              Detailed Findings & Report
            </h3>
            <div className="p-4 rounded-lg bg-surface-raised border border-border text-xs font-mono text-foreground leading-relaxed whitespace-pre-wrap">
              {result.reportMarkdown}
            </div>
          </div>
        ) : null}

        {/* Generated Artifacts */}
        {result.artifacts && result.artifacts.length > 0 ? (
          <div>
            <h3 className="text-xs font-mono font-semibold text-foreground-muted uppercase tracking-wider mb-2">
              Generated Artifacts ({result.artifacts.length.toString()})
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.artifacts.map((artifact) => (
                <div
                  key={artifact.path}
                  className="flex items-center gap-2 px-3 py-1.5 rounded bg-surface-raised border border-border text-xs font-mono text-foreground"
                >
                  <FileText className="w-3.5 h-3.5 text-accent" />
                  <span>{artifact.name}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
};
