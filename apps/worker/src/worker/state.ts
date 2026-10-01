import type {
  WorkerErrorContract,
  WorkerState,
} from "@aegis/contracts";
import {
  createWorkerError,
  isValidWorkerTransition,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

/**
 * Manages atomic lifecycle state transitions for a local worker process.
 * Enforces the strict transition state machine defined in @aegis/contracts.
 */
export class WorkerLifecycleManager {
  private currentState: WorkerState;

  constructor(initialState: WorkerState = "starting") {
    this.currentState = initialState;
  }

  /**
   * Returns the current lifecycle state of the worker.
   */
  public getState(): WorkerState {
    return this.currentState;
  }

  /**
   * Attempts to transition to the requested next state.
   * Fails fast if the transition is prohibited by canonical transition rules.
   */
  public transitionTo(nextState: WorkerState): Result<void, WorkerErrorContract> {
    if (this.currentState === nextState) {
      return err(
        createWorkerError(
          "WORKER_INVALID_STATE",
          `Worker is already in state '${this.currentState}'. Transition to identical state is not allowed.`,
        ),
      );
    }

    if (!isValidWorkerTransition(this.currentState, nextState)) {
      return err(
        createWorkerError(
          "WORKER_INVALID_STATE",
          `Invalid worker state transition: cannot transition from '${this.currentState}' to '${nextState}'.`,
        ),
      );
    }

    this.currentState = nextState;
    return ok(undefined);
  }
}
