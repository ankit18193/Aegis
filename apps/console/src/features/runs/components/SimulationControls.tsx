import { Ban, Pause, Play, RotateCcw } from "lucide-react";
import * as React from "react";

import { Button } from "../../../components/ui/Button";
import { useSimulation } from "../hooks/useSimulation";
import type { Run } from "../types";

export interface SimulationControlsProps {
  run: Run;
}

export const SimulationControls: React.FC<SimulationControlsProps> = ({ run }) => {
  const { isSimulating, start, pause, reset, cancel } = useSimulation(run.id);

  const isCompleted = run.status === "completed";
  const isFailed = run.status === "failed";
  const isCancelled = run.status === "cancelled";
  const isFinished = isCompleted || isFailed || isCancelled;

  return (
    <div
      className="flex items-center gap-1.5 select-none"
      role="toolbar"
      aria-label="Simulation controls"
      data-testid="simulation-controls"
    >
      {isSimulating ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={pause}
            data-testid="pause-simulation-btn"
            title="Pause simulation"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>Pause</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void cancel(); }}
            data-testid="cancel-simulation-btn"
            title="Cancel execution run"
          >
            <Ban className="w-3.5 h-3.5 text-rose-400" />
            <span>Cancel</span>
          </Button>
        </>
      ) : isFinished ? (
        <>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void start(600); }}
            data-testid="rerun-simulation-btn"
            title="Restart and simulate run from beginning"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Rerun Simulation</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void reset(); }}
            data-testid="reset-simulation-btn"
            title="Reset to pending state"
          >
            <span>Reset</span>
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void start(600); }}
            data-testid="start-simulation-btn"
            title="Start deterministic execution simulation"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Simulate Run</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void cancel(); }}
            data-testid="cancel-simulation-btn"
            title="Cancel execution run"
          >
            <Ban className="w-3.5 h-3.5 text-rose-400" />
            <span>Cancel</span>
          </Button>
        </>
      )}
    </div>
  );
};
