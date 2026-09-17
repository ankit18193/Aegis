import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { RunHeader } from "../components/RunHeader";
import { RunProgress } from "../components/RunProgress";
import { useRun } from "../hooks/useRun";

export const RunWorkspace: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const { run, isLoading, error } = useRun(runId);

  if (isLoading) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center p-12 text-foreground-muted"
        data-testid="run-workspace-loading"
      >
        <Loader2 className="w-6 h-6 animate-spin mb-3 text-accent" />
        <span className="text-xs font-mono">Loading run workspace...</span>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div
        className="flex-1 flex items-center justify-center p-8"
        data-testid="run-not-found"
      >
        <EmptyState
          icon={AlertCircle}
          title="Run Not Found"
          description={
            runId
              ? `No execution run was found matching identifier "${runId}".`
              : "No run identifier was provided."
          }
          action={
            <Link to="/runs">
              <Button variant="outline" size="sm">
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                <span>Back to Runs</span>
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto"
      data-testid="run-workspace"
    >
      {/* Run Header */}
      <RunHeader run={run} />

      {/* Progress Bar */}
      <RunProgress run={run} />

      {/* Workspace Content Grid */}
      <div className="flex-1 p-6 space-y-6">
        {/* Placeholder for Commit 6 (Workflow & Tasks) and Commit 7 (Activity) */}
        <section
          aria-labelledby="workflow-section-title"
          className="bg-surface rounded-lg border border-border p-5"
          data-testid="workspace-content"
        >
          <div className="flex items-center justify-between mb-4">
            <h2
              id="workflow-section-title"
              className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground-muted"
            >
              Workflow: {run.workflow.name}
            </h2>
            <span className="text-xs font-mono text-foreground-muted">
              {run.tasks.length.toString()} tasks defined
            </span>
          </div>

          <div className="space-y-2">
            {run.tasks.map((task, idx) => (
              <div
                key={task.id}
                className="flex items-center justify-between p-3 rounded bg-surface-raised border border-border-subtle text-xs font-mono"
              >
                <div className="flex items-center gap-3">
                  <span className="text-foreground-muted w-4 text-right">
                    {(idx + 1).toString()}.
                  </span>
                  <span className="text-foreground font-medium">{task.name}</span>
                </div>
                <span className="capitalize text-foreground-muted">{task.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
