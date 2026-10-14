import type {
  Run,
  RunEvent,
  RunResult,
  RunStatus,
  Task,
  TaskStatus,
} from "@aegis/contracts";
import { workerId } from "@aegis/types";

/**
 * Normalized state model for real-time execution in the Aegis Console.
 */
export interface ExecutionState {
  /**
   * The active run representation, containing updated task states, progress, and status.
   */
  readonly run: Run | null;

  /**
   * Chronological list of execution events received for this run.
   */
  readonly events: readonly RunEvent[];

  /**
   * Set of processed event IDs used for fast deterministic deduplication.
   */
  readonly seenEventIds: ReadonlySet<string>;

  /**
   * Timestamp of the most recently processed stream event.
   */
  readonly lastEventTimestamp?: string;
}

/**
 * Clean initial execution state.
 */
export const initialExecutionState: ExecutionState = {
  run: null,
  events: [],
  seenEventIds: new Set<string>(),
};

/**
 * Supported reducer actions for execution state management.
 */
export type ExecutionAction =
  | {
      type: "INIT_RUN";
      payload: {
        run: Run;
        initialEvents?: RunEvent[];
      };
    }
  | {
      type: "STREAM_EVENT";
      payload: RunEvent;
    }
  | {
      type: "RESET";
    };

/**
 * Helper to compute workflow progress percentage from current task statuses.
 * Caps progress at 95% until the run is formally completed (which sets 100%).
 */
function calculateTaskProgress(tasks: readonly Task[]): number {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter((t) => t.status === "completed").length;
  return Math.min(95, Math.round((completed / tasks.length) * 100));
}

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Checks if a proposed task status transition is a valid forward progression.
 * Protects terminal states and prevents backward regressions.
 */
function canTransitionTaskState(current: TaskStatus, target: TaskStatus): boolean {
  if (current === target) return false;
  if (TERMINAL_TASK_STATUSES.has(current)) return false;

  switch (current) {
    case "pending":
      return target === "queued" || target === "running" || target === "failed" || target === "cancelled";
    case "queued":
      return target === "running" || target === "failed" || target === "cancelled";
    case "running":
      return target === "completed" || target === "failed" || target === "retrying" || target === "cancelled";
    case "retrying":
      return target === "queued" || target === "running" || target === "failed" || target === "cancelled";
    default:
      return false;
  }
}

/**
 * Checks if a proposed run status transition is valid.
 * Protects terminal states and prevents backward regressions.
 */
function canTransitionRunState(current: RunStatus, target: RunStatus): boolean {
  if (current === target) return false;
  if (TERMINAL_RUN_STATUSES.has(current)) return false;

  switch (current) {
    case "pending":
      return target === "running" || target === "failed" || target === "cancelled";
    case "running":
      return target === "completed" || target === "failed" || target === "cancelled";
    default:
      return false;
  }
}

/**
 * Safely applies an updated status to a task only if the transition is valid according
 * to canonical task transition rules. Returns the updated task or the original task if invalid.
 */
function applyTaskStatusTransition(
  task: Task,
  targetStatus: TaskStatus,
  event: RunEvent,
): Task {
  if (!canTransitionTaskState(task.status, targetStatus)) {
    return task;
  }

  const updated: Task = {
    ...task,
    status: targetStatus,
  };

  if (targetStatus === "running") {
    updated.startedAt = updated.startedAt ?? event.timestamp;
    if (event.worker) {
      updated.worker = event.worker;
      updated.workerId = event.worker;
    }
  } else if (targetStatus === "completed") {
    updated.completedAt = event.timestamp;
    if (typeof event.metadata?.output === "string") {
      updated.output = event.metadata.output;
    } else if (typeof event.metadata?.result === "string") {
      updated.output = event.metadata.result;
    }
  } else if (targetStatus === "failed") {
    updated.completedAt = event.timestamp;
    if (typeof event.metadata?.error === "string") {
      updated.error = event.metadata.error;
    } else {
      updated.error = event.message;
    }
  } else if (targetStatus === "cancelled") {
    updated.completedAt = event.timestamp;
  }

  return updated;
}

/**
 * Safely applies an updated status to a run only if the transition is valid according
 * to canonical run transition rules. Returns the updated run or original run if invalid.
 */
function applyRunStatusTransition(
  run: Run,
  targetStatus: RunStatus,
  event: RunEvent,
): Run {
  if (!canTransitionRunState(run.status, targetStatus)) {
    return run;
  }

  const updated: Run = {
    ...run,
    status: targetStatus,
    updatedAt: event.timestamp,
  };

  if (targetStatus === "completed") {
    updated.progress = 100;
    if (event.metadata?.result) {
      updated.result = event.metadata.result as RunResult;
    }
  }

  return updated;
}

/**
 * Pure, deterministic reducer for real-time execution state in the Aegis Console.
 *
 * Guarantees:
 * 1. Deterministic output: given identical initial state and event sequence, produces identical state.
 * 2. Event deduplication: duplicate event IDs are detected and discarded.
 * 3. Terminal state protection: terminal states ('completed', 'failed', 'cancelled') can never revert.
 * 4. Progressive state updates: task completion automatically calculates progress.
 */
export function reduceExecutionState(
  state: ExecutionState,
  action: ExecutionAction,
): ExecutionState {
  switch (action.type) {
    case "INIT_RUN": {
      const initialEvents = action.payload.initialEvents ?? [];
      const seen = new Set<string>();
      for (const ev of initialEvents) {
        if (ev.id) seen.add(ev.id);
      }

      return {
        run: action.payload.run,
        events: initialEvents,
        seenEventIds: seen,
        lastEventTimestamp:
          initialEvents[initialEvents.length - 1]?.timestamp ?? action.payload.run.createdAt,
      };
    }

    case "RESET": {
      return initialExecutionState;
    }

    case "STREAM_EVENT": {
      const event = action.payload;

      // Deduplication: reject if event ID was already processed
      if (event.id && state.seenEventIds.has(event.id)) {
        return state;
      }

      // Record seen event ID
      const nextSeen = new Set(state.seenEventIds);
      if (event.id) {
        nextSeen.add(event.id);
      }

      // Append event to chronological timeline
      const nextEvents = [...state.events, event];

      // If no active run in state, record event in timeline only
      if (!state.run) {
        return {
          ...state,
          events: nextEvents,
          seenEventIds: nextSeen,
          lastEventTimestamp: event.timestamp,
        };
      }

      let currentRun = state.run;

      // 1. Process Task-level events
      if (event.taskId) {
        const taskIndex = currentRun.tasks.findIndex((t) => t.id === event.taskId);
        if (taskIndex !== -1) {
          const originalTask = currentRun.tasks[taskIndex];
          if (originalTask) {
            let updatedTask = originalTask;

            switch (event.type) {
              case "task_scheduled":
                updatedTask = applyTaskStatusTransition(originalTask, "queued", event);
                break;

              case "task_started":
                updatedTask = applyTaskStatusTransition(originalTask, "running", event);
                // An active task starting implicitly transitions pending run to running
                if (currentRun.status === "pending") {
                  currentRun = applyRunStatusTransition(currentRun, "running", event);
                }
                break;

              case "task_completed":
                updatedTask = applyTaskStatusTransition(originalTask, "completed", event);
                break;

              case "task_failed":
                updatedTask = applyTaskStatusTransition(originalTask, "failed", event);
                break;

              case "task_cancelled":
                updatedTask = applyTaskStatusTransition(originalTask, "cancelled", event);
                break;

              case "task_lease_expired": {
                const leaseExpiredAt = event.timestamp;
                const withLease = { ...originalTask, leaseExpiredAt };
                updatedTask = applyTaskStatusTransition(withLease, "retrying", event);
                break;
              }

              case "task_reassigned": {
                const newWorkerRaw =
                  typeof event.metadata?.newWorkerId === "string"
                    ? event.metadata.newWorkerId
                    : undefined;
                const newWorker = newWorkerRaw ? workerId(newWorkerRaw) : event.worker;
                const newLeaseId =
                  typeof event.metadata?.newLeaseId === "string"
                    ? event.metadata.newLeaseId
                    : undefined;
                const attemptCount =
                  typeof event.metadata?.attemptCount === "number"
                    ? event.metadata.attemptCount
                    : originalTask.attemptCount;

                updatedTask = {
                  ...originalTask,
                  ...(newWorker ? { worker: newWorker, workerId: newWorker } : {}),
                  ...(newLeaseId ? { leaseId: newLeaseId } : {}),
                  attemptCount,
                  leaseExpiredAt: undefined,
                };
                break;
              }

              case "tool_invoked":
                // Informational execution step; does not alter task status
                break;

              default:
                break;
            }

            if (updatedTask !== originalTask) {
              const updatedTasks = [...currentRun.tasks];
              updatedTasks[taskIndex] = updatedTask;

              const progress =
                currentRun.status === "completed"
                  ? 100
                  : calculateTaskProgress(updatedTasks);

              currentRun = {
                ...currentRun,
                tasks: updatedTasks,
                progress,
              };
            }
          }
        }
      }

      // 2. Process Run-level events
      switch (event.type) {
        case "workflow_started":
          currentRun = applyRunStatusTransition(currentRun, "running", event);
          break;

        case "run_completed":
          currentRun = applyRunStatusTransition(currentRun, "completed", event);
          break;

        case "run_failed":
          currentRun = applyRunStatusTransition(currentRun, "failed", event);
          break;

        case "run_cancelled":
          currentRun = applyRunStatusTransition(currentRun, "cancelled", event);
          break;

        default:
          break;
      }

      return {
        run: currentRun,
        events: nextEvents,
        seenEventIds: nextSeen,
        lastEventTimestamp: event.timestamp,
      };
    }

    default:
      return state;
  }
}
