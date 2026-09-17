import { eventService } from "../../events/services/eventService";
import type { Run, RunResult, TaskSummary } from "../types";

import { mockRunRepository } from "./mockRunRepository";

export interface SimulationState {
  isRunning: boolean;
  isPaused: boolean;
}

class SimulationEngine {
  private activeSimulations = new Map<string, { timerId?: ReturnType<typeof setTimeout>; abortController: AbortController }>();
  private listeners = new Set<(runId: string, state: SimulationState) => void>();

  public isSimulating(runId: string): boolean {
    return this.activeSimulations.has(runId);
  }

  public subscribe(listener: (runId: string, state: SimulationState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(runId: string, isRunning: boolean, isPaused: boolean): void {
    for (const listener of this.listeners) {
      try {
        listener(runId, { isRunning, isPaused });
      } catch {
        // ignore subscriber errors
      }
    }
  }

  public async startSimulation(runId: string, stepDurationMs = 750): Promise<void> {
    if (this.activeSimulations.has(runId)) {
      return;
    }

    const run = await mockRunRepository.getRunById(runId);
    if (!run) return;

    // If run was already completed or failed, reset tasks first so we can play from start
    let currentRun = run;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      currentRun = await this.resetRunTasks(runId);
    }

    const abortController = new AbortController();
    this.activeSimulations.set(runId, { abortController });
    this.notify(runId, true, false);

    try {
      await this.runLoop(currentRun, stepDurationMs, abortController.signal);
    } catch {
      // Abort or termination caught cleanly
    } finally {
      this.activeSimulations.delete(runId);
      this.notify(runId, false, false);
    }
  }

  public pauseSimulation(runId: string): void {
    const active = this.activeSimulations.get(runId);
    if (active) {
      active.abortController.abort();
      this.activeSimulations.delete(runId);
      this.notify(runId, false, true);
    }
  }

  public async cancelSimulation(runId: string): Promise<void> {
    this.pauseSimulation(runId);
    const run = await mockRunRepository.getRunById(runId);
    if (!run) return;

    await mockRunRepository.updateRun(runId, {
      status: "cancelled",
    });

    await eventService.recordEvent(runId, {
      type: "run_cancelled",
      severity: "warn",
      timestamp: new Date().toISOString(),
      message: "Execution run was manually cancelled by operator.",
    });
  }

  public async resetRunTasks(runId: string): Promise<Run> {
    this.pauseSimulation(runId);
    const run = await mockRunRepository.getRunById(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const resetTasks: TaskSummary[] = run.tasks.map((task) => ({
      ...task,
      status: "pending",
      attemptCount: 0,
      startedAt: undefined,
      completedAt: undefined,
      output: undefined,
      error: undefined,
    }));

    const updated = await mockRunRepository.updateRun(runId, {
      status: "pending",
      progress: 0,
      tasks: resetTasks,
      workflow: {
        ...run.workflow,
        tasks: resetTasks,
      },
      result: undefined,
    });

    await eventService.recordEvent(runId, {
      type: "workflow_started",
      severity: "info",
      timestamp: new Date().toISOString(),
      message: "Run simulation reset to initial pending state.",
    });

    return updated;
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Simulation aborted"));
        return;
      }
      const timer = setTimeout(() => {
        resolve();
      }, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Simulation aborted"));
      });
    });
  }

  private async runLoop(initialRun: Run, stepDurationMs: number, signal: AbortSignal): Promise<void> {
    const runId = initialRun.id;

    // Step 1: Transition Run from PENDING to RUNNING
    if (initialRun.status !== "running") {
      await mockRunRepository.updateRun(runId, {
        status: "running",
        progress: 5,
      });

      await eventService.recordEvent(runId, {
        type: "workflow_started",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: `Workflow '${initialRun.workflow.name}' started execution across distributed workers.`,
      });

      await this.sleep(stepDurationMs, signal);
    }

    // Step 2: Step through each task sequentially
    const tasks = [...initialRun.tasks];
    const totalTasks = tasks.length;

    for (let i = 0; i < totalTasks; i++) {
      const currentTask = tasks[i];
      if (!currentTask) continue;

      if (currentTask.status === "completed") {
        continue;
      }

      // 2a. Task transition to RUNNING
      const now = new Date().toISOString();
      const workerName = currentTask.worker ?? `worker-node-${((i % 3) + 1).toString()}`;

      currentTask.status = "running";
      currentTask.worker = workerName;
      currentTask.startedAt = now;
      currentTask.attemptCount = 1;

      const runningProgress = Math.min(90, Math.round(((i + 0.5) / totalTasks) * 100));

      await mockRunRepository.updateRun(runId, {
        tasks: [...tasks],
        progress: runningProgress,
      });

      await eventService.recordEvent(runId, {
        type: "task_started",
        severity: "info",
        timestamp: now,
        taskId: currentTask.id,
        taskName: currentTask.name,
        worker: workerName,
        message: `Worker '${workerName}' began executing task '${currentTask.name}'.`,
      });

      await this.sleep(stepDurationMs, signal);

      // 2b. Simulated tool invocation
      await eventService.recordEvent(runId, {
        type: "tool_invoked",
        severity: "info",
        timestamp: new Date().toISOString(),
        taskId: currentTask.id,
        message: `Tool invoked: worker_executor_${(i + 1).toString()} (step verified)`,
      });

      await this.sleep(stepDurationMs, signal);

      // 2c. Task transition to COMPLETED
      const completedAt = new Date().toISOString();
      currentTask.status = "completed";
      currentTask.completedAt = completedAt;
      currentTask.output = `Task execution verified. Output artifacts verified for '${currentTask.name}'.`;

      const completedProgress = Math.min(95, Math.round(((i + 1) / totalTasks) * 100));

      await mockRunRepository.updateRun(runId, {
        tasks: [...tasks],
        progress: completedProgress,
      });

      await eventService.recordEvent(runId, {
        type: "task_completed",
        severity: "success",
        timestamp: completedAt,
        taskId: currentTask.id,
        taskName: currentTask.name,
        worker: workerName,
        message: `Task '${currentTask.name}' completed successfully.`,
      });

      await this.sleep(stepDurationMs, signal);
    }

    // Step 3: All tasks complete -> Run transition to COMPLETED
    const finalResult: RunResult = {
      summary: `Autonomous agent run completed all ${totalTasks.toString()} tasks successfully with 0 policy violations and verified output artifacts.`,
      reportMarkdown: `### Execution Summary Report

- **Goal:** ${initialRun.goal}
- **Total Workflow Tasks:** ${totalTasks.toString()} / ${totalTasks.toString()}
- **Status:** COMPLETED (0 errors, 0 retries required)
- **Artifacts:** Verified telemetry logs and synthesis markdown

All distributed task criteria satisfied. System telemetry clean.`,
      metrics: {
        durationMs: totalTasks * stepDurationMs * 3,
        tasksTotal: totalTasks,
        tasksCompleted: totalTasks,
        toolInvocations: totalTasks * 2,
      },
      artifacts: [
        {
          name: "execution-summary.md",
          type: "markdown",
          path: `/runs/${runId}/summary.md`,
          sizeBytes: 2450,
        },
      ],
    };

    await mockRunRepository.updateRun(runId, {
      status: "completed",
      progress: 100,
      result: finalResult,
    });

    await eventService.recordEvent(runId, {
      type: "run_completed",
      severity: "success",
      timestamp: new Date().toISOString(),
      message: `Run ${runId} reached COMPLETED state. Results generated.`,
    });
  }
}

export const simulationEngine = new SimulationEngine();
