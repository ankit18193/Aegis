import { AlertCircle, ArrowLeft, CheckSquare, Loader2 } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ActivityTimeline } from "../../events/components/ActivityTimeline";
import { useRunEvents } from "../../events/hooks/useRunEvents";
import { TaskCard } from "../../tasks/components/TaskCard";
import { TaskDetailDrawer } from "../../tasks/components/TaskDetailDrawer";
import { RunHeader } from "../components/RunHeader";
import { RunProgress } from "../components/RunProgress";
import { RunResultView } from "../components/RunResultView";
import { SimulationControls } from "../components/SimulationControls";
import { WorkflowProgress } from "../components/WorkflowProgress";
import { useRun } from "../hooks/useRun";
import type { TaskSummary } from "../types";

export const RunWorkspace: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const { run, isLoading: isRunLoading, error } = useRun(runId);
  const { events, isLoading: isEventsLoading } = useRunEvents(runId);
  const [selectedTask, setSelectedTask] = React.useState<TaskSummary | null>(null);

  if (isRunLoading) {
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
      {/* Run Header with Simulation Controls */}
      <RunHeader run={run} actions={<SimulationControls run={run} />} />

      {/* Progress Bar */}
      <RunProgress run={run} />

      {/* Workspace Main Content */}
      <div className="flex-1 p-4 sm:p-6 space-y-6 max-w-5xl">
        {/* Run Result Output (when run has finished) */}
        {run.result ? <RunResultView result={run.result} /> : null}

        {/* Workflow Progression Stepper */}
        <WorkflowProgress
          tasks={run.tasks}
          selectedTaskId={selectedTask?.id}
          onTaskClick={(task) => { setSelectedTask(task); }}
        />

        {/* Task Inspection List */}
        <section
          aria-labelledby="tasks-section-title"
          className="space-y-3"
          data-testid="tasks-section"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-foreground-muted" />
              <h2
                id="tasks-section-title"
                className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground-muted"
              >
                Workflow Tasks ({run.tasks.length.toString()})
              </h2>
            </div>
            <span className="text-[11px] font-mono text-foreground-muted">
              Select a task to view execution details & outputs
            </span>
          </div>

          <div className="space-y-2">
            {run.tasks.map((task, idx) => (
              <TaskCard
                key={task.id}
                task={task}
                index={idx}
                isSelected={selectedTask?.id === task.id}
                onClick={(t) => { setSelectedTask(t); }}
              />
            ))}
          </div>
        </section>

        {/* Activity Timeline Stream */}
        <ActivityTimeline events={events} isLoading={isEventsLoading} />
      </div>

      {/* Task Inspection Slide-Over Drawer */}
      <TaskDetailDrawer
        task={selectedTask}
        onClose={() => { setSelectedTask(null); }}
      />
    </div>
  );
};
