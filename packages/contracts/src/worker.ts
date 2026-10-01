import type { Result } from "@aegis/types";
import { z } from "zod";

import { workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Worker Lifecycle States & Transition Rules
// ─────────────────────────────────────────────────────────────────────────────

export const workerStateSchema = z.enum([
  "starting",
  "ready",
  "draining",
  "stopped",
  "failed",
]);
export type WorkerState = z.infer<typeof workerStateSchema>;

export const WorkerLifecycleState = {
  STARTING: "starting",
  READY: "ready",
  DRAINING: "draining",
  STOPPED: "stopped",
  FAILED: "failed",
} as const;

export const VALID_WORKER_TRANSITIONS: Readonly<Record<WorkerState, readonly WorkerState[]>> = {
  starting: ["ready", "failed", "stopped"],
  ready: ["draining", "failed"],
  draining: ["stopped"],
  failed: ["stopped"],
  stopped: [],
};

/**
 * Validates whether transitioning from one worker state to another is permissible.
 */
export function isValidWorkerTransition(from: WorkerState, to: WorkerState): boolean {
  return VALID_WORKER_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Capabilities Contract
// ─────────────────────────────────────────────────────────────────────────────

export const workerCapabilitiesSchema = z.object({
  taskTypes: z.array(z.string().min(1)).min(1),
  tools: z.array(z.string().min(1)),
  maxConcurrency: z.number().int().positive(),
});
export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Worker Identity Contract
// ─────────────────────────────────────────────────────────────────────────────

export const workerIdentitySchema = z.object({
  id: workerIdSchema,
  name: z.string().min(1),
  startedAt: z.string().datetime(),
  capabilities: workerCapabilitiesSchema,
});
export type WorkerIdentity = z.infer<typeof workerIdentitySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Worker Errors & Error Codes
// ─────────────────────────────────────────────────────────────────────────────

export const workerErrorCodeSchema = z.enum([
  "WORKER_ALREADY_STARTED",
  "WORKER_NOT_READY",
  "WORKER_INVALID_STATE",
  "WORKER_START_FAILED",
  "WORKER_STOP_FAILED",
  "INVALID_WORKER_CONFIG",
]);
export type WorkerErrorCode = z.infer<typeof workerErrorCodeSchema>;

export interface WorkerErrorContract {
  readonly code: WorkerErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function createWorkerError(
  code: WorkerErrorCode,
  message: string,
  cause?: unknown,
): WorkerErrorContract {
  return { code, message, cause };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Runtime Boundary Contract (Phase 11A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Foundational contract for the Aegis local worker runtime process.
 * Manages identity, capabilities, and lifecycle state.
 * Does not expose task execution (Phase 11C) or Kafka consumption (Phase 11B).
 */
export interface IWorkerRuntime {
  start(): Promise<Result<void, WorkerErrorContract>>;
  stop(): Promise<Result<void, WorkerErrorContract>>;
  getState(): WorkerState;
  getIdentity(): WorkerIdentity;
  readonly isRunning: boolean;
}
