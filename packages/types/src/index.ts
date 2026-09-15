import type { HealthStatus } from "@aegis/foundation";

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID types
// ─────────────────────────────────────────────────────────────────────────────

/** Opaque brand utility for nominal typing. */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** A unique identifier for an Agent. */
export type AgentId = Brand<string, "AgentId">;

/** A unique identifier for a Workflow. */
export type WorkflowId = Brand<string, "WorkflowId">;

/** A unique identifier for a Task. */
export type TaskId = Brand<string, "TaskId">;

/** A unique identifier for a Worker node. */
export type WorkerId = Brand<string, "WorkerId">;

/**
 * Creates a branded AgentId from a raw string.
 * Use this at trust boundaries (e.g., when reading from a database).
 */
export function agentId(raw: string): AgentId {
  return raw as AgentId;
}

/**
 * Creates a branded WorkflowId from a raw string.
 */
export function workflowId(raw: string): WorkflowId {
  return raw as WorkflowId;
}

/**
 * Creates a branded TaskId from a raw string.
 */
export function taskId(raw: string): TaskId {
  return raw as TaskId;
}

/**
 * Creates a branded WorkerId from a raw string.
 */
export function workerId(raw: string): WorkerId {
  return raw as WorkerId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Common domain enumerations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Possible lifecycle statuses for an Agent.
 *
 * NOTE: This is a placeholder type. The full lifecycle state machine
 * will be defined when agent orchestration is implemented.
 */
export enum AgentStatus {
  /** Agent is created but not yet scheduled. */
  Pending = "pending",
  /** Agent is actively executing. */
  Running = "running",
  /** Agent has completed successfully. */
  Completed = "completed",
  /** Agent execution failed. */
  Failed = "failed",
  /** Agent was cancelled before completion. */
  Cancelled = "cancelled",
}

/**
 * Possible lifecycle statuses for a Workflow.
 *
 * NOTE: Placeholder type. Workflow execution engine is not yet implemented.
 */
export enum WorkflowStatus {
  Draft = "draft",
  Active = "active",
  Paused = "paused",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural result type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A discriminated union result type for operations that can fail.
 *
 * Prefer this over throwing exceptions in domain logic.
 */
export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/**
 * Creates a successful Result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Creates a failed Result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports from foundation for consumer convenience
// ─────────────────────────────────────────────────────────────────────────────

export type { HealthStatus };
