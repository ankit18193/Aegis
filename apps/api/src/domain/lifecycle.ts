/**
 * Pure lifecycle state machines and transition validators for Aegis Runs and Tasks.
 * Enforces canonical transitions and terminal state immutability.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { InvalidStateTransitionError, TerminalStateError } from "./errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Run Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const VALID_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from].includes(to);
}

export function assertValidRunTransition(
  from: RunStatus,
  to: RunStatus,
): Result<void, TerminalStateError | InvalidStateTransitionError> {
  if (isTerminalRunStatus(from)) {
    return err(new TerminalStateError("run", from, to));
  }
  if (!canTransitionRun(from, to)) {
    return err(new InvalidStateTransitionError("run", from, to));
  }
  return ok(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Lifecycle (Phase 4 — retries excluded)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const VALID_TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["queued", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from].includes(to);
}

export function assertValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): Result<void, TerminalStateError | InvalidStateTransitionError> {
  if (isTerminalTaskStatus(from)) {
    return err(new TerminalStateError("task", from, to));
  }
  if (!canTransitionTask(from, to)) {
    return err(new InvalidStateTransitionError("task", from, to));
  }
  return ok(undefined);
}
