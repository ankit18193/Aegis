import * as React from "react";

import { simulationEngine } from "../services/simulationEngine";

export function useSimulation(runId: string | undefined): {
  isSimulating: boolean;
  isPaused: boolean;
  start: (stepDurationMs?: number) => Promise<void>;
  pause: () => void;
  reset: () => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [state, setState] = React.useState({
    isSimulating: runId ? simulationEngine.isSimulating(runId) : false,
    isPaused: false,
  });

  React.useEffect(() => {
    if (!runId) return;

    const unsubscribe = simulationEngine.subscribe((activeRunId, simState) => {
      if (activeRunId === runId) {
        setState({
          isSimulating: simState.isRunning,
          isPaused: simState.isPaused,
        });
      }
    });

    return unsubscribe;
  }, [runId]);

  const start = React.useCallback(
    async (stepDurationMs = 700): Promise<void> => {
      if (!runId) return;
      await simulationEngine.startSimulation(runId, stepDurationMs);
    },
    [runId]
  );

  const pause = React.useCallback((): void => {
    if (!runId) return;
    simulationEngine.pauseSimulation(runId);
  }, [runId]);

  const reset = React.useCallback(async (): Promise<void> => {
    if (!runId) return;
    await simulationEngine.resetRunTasks(runId);
  }, [runId]);

  const cancel = React.useCallback(async (): Promise<void> => {
    if (!runId) return;
    await simulationEngine.cancelSimulation(runId);
  }, [runId]);

  return {
    isSimulating: state.isSimulating,
    isPaused: state.isPaused,
    start,
    pause,
    reset,
    cancel,
  };
}
