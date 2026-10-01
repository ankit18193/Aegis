/**
 * AgentState model for the Aegis Agent Runtime.
 * Manages pure agent execution state (iteration, turns history, context, and termination),
 * decoupled from the authoritative Run lifecycle.
 */

import type { RunId } from "@aegis/types";

import type { AgentAction, Observation } from "./action.js";

export type AgentRuntimeStatus =
  | "idle"
  | "planning"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentTurnRecord {
  readonly iteration: number;
  readonly action: AgentAction;
  readonly observation: Observation;
  readonly timestamp: string;
}

export interface AgentTerminationInfo {
  readonly reason: string;
  readonly completedAt: string;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface AgentStateSnapshot {
  readonly runId: RunId;
  readonly goal: string;
  readonly iteration: number;
  readonly status: AgentRuntimeStatus;
  readonly context: Record<string, unknown>;
  readonly history: readonly AgentTurnRecord[];
  readonly termination?: AgentTerminationInfo | undefined;
}

export class AgentState {
  private _iteration: number;
  private _status: AgentRuntimeStatus;
  private _context: Record<string, unknown>;
  private _history: AgentTurnRecord[];
  private _termination?: AgentTerminationInfo | undefined;

  private constructor(
    readonly runId: RunId,
    readonly goal: string,
    iteration = 0,
    status: AgentRuntimeStatus = "idle",
    context: Record<string, unknown> = {},
    history: AgentTurnRecord[] = [],
    termination?: AgentTerminationInfo,
  ) {
    this._iteration = iteration;
    this._status = status;
    this._context = { ...context };
    this._history = [...history];
    this._termination = termination;
  }

  static init(runId: RunId, goal: string, initialContext: Record<string, unknown> = {}): AgentState {
    return new AgentState(runId, goal, 0, "idle", initialContext, []);
  }

  static reconstitute(snapshot: AgentStateSnapshot): AgentState {
    return new AgentState(
      snapshot.runId,
      snapshot.goal,
      snapshot.iteration,
      snapshot.status,
      snapshot.context,
      [...snapshot.history],
      snapshot.termination,
    );
  }

  get iteration(): number {
    return this._iteration;
  }

  get status(): AgentRuntimeStatus {
    return this._status;
  }

  get context(): Readonly<Record<string, unknown>> {
    return this._context;
  }

  get history(): readonly AgentTurnRecord[] {
    return this._history;
  }

  get termination(): AgentTerminationInfo | undefined {
    return this._termination;
  }

  isTerminal(): boolean {
    return (
      this._status === "completed" ||
      this._status === "failed" ||
      this._status === "cancelled"
    );
  }

  setStatus(status: AgentRuntimeStatus): void {
    if (this.isTerminal()) {
      return; // Terminal immutability
    }
    this._status = status;
  }

  incrementIteration(): number {
    if (this.isTerminal()) {
      return this._iteration;
    }
    this._iteration += 1;
    return this._iteration;
  }

  updateContext(updates: Record<string, unknown>): void {
    if (this.isTerminal()) {
      return;
    }
    this._context = { ...this._context, ...updates };
  }

  recordTurn(action: AgentAction, observation: Observation): void {
    if (this.isTerminal()) {
      return;
    }
    this._history.push({
      iteration: this._iteration,
      action,
      observation,
      timestamp: observation.timestamp,
    });
  }

  markCompleted(
    summary: string,
    output?: string,
    completedAt: string = new Date().toISOString(),
  ): void {
    if (this.isTerminal()) {
      return;
    }
    this._status = "completed";
    this._termination = {
      reason: summary,
      output: output ?? summary,
      completedAt,
    };
  }

  markFailed(
    reason: string,
    error?: string,
    failedAt: string = new Date().toISOString(),
  ): void {
    if (this.isTerminal()) {
      return;
    }
    this._status = "failed";
    this._termination = {
      reason,
      error: error ?? reason,
      completedAt: failedAt,
    };
  }

  markCancelled(
    reason = "Execution cancelled",
    cancelledAt: string = new Date().toISOString(),
  ): void {
    if (this.isTerminal()) {
      return;
    }
    this._status = "cancelled";
    this._termination = {
      reason,
      completedAt: cancelledAt,
    };
  }

  toSnapshot(): AgentStateSnapshot {
    return {
      runId: this.runId,
      goal: this.goal,
      iteration: this._iteration,
      status: this._status,
      context: { ...this._context },
      history: [...this._history],
      termination: this._termination ? { ...this._termination } : undefined,
    };
  }
}
