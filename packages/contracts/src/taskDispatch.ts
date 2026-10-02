import type { Result, RunId, WorkerId } from "@aegis/types";
import { z } from "zod";

import {
  runIdSchema,
  taskIdSchema,
  workerIdSchema,
  type Task,
} from "./runs.js";
import {
  assignmentIdSchema,
  type TaskAssignmentEnvelope,
} from "./taskAssignment.js";
import {
  workerDescriptorSchema,
  type WorkerDescriptor,
} from "./workerHeartbeat.js";

// ─────────────────────────────────────────────────────────────────────────────
// Worker-Targeted Topic Routing Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the dedicated, worker-targeted assignment topic.
 * Follows the naming scheme: `${baseTopic}.${workerId}`.
 * Strictly enforces non-empty workerId; never allows unrouted fallback during dispatch.
 */
export function resolveWorkerAssignmentTopic(
  baseTopic: string,
  workerId: WorkerId,
): string {
  if (!baseTopic || typeof baseTopic !== "string" || baseTopic.trim() === "") {
    throw new Error(
      "Cannot resolve worker assignment topic: baseTopic must be a non-empty string.",
    );
  }
  if (!workerId || typeof workerId !== "string" || workerId.trim() === "") {
    throw new Error(
      "Cannot resolve worker assignment topic: workerId is required and must be non-empty.",
    );
  }
  return `${baseTopic.trim()}.${workerId.trim()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Requirements Contract (Derived from Task/Worker Capabilities)
// ─────────────────────────────────────────────────────────────────────────────

export const taskRequirementsSchema = z.object({
  taskType: z.string().min(1),
  requiredTools: z.array(z.string().min(1)).default([]),
});
export type TaskRequirements = z.infer<typeof taskRequirementsSchema>;

/**
 * Extracts normalized TaskRequirements from a Task entity or definition.
 * Uses task.name as the primary task type.
 * Inspects task.input for optional requiredTools or tools arrays.
 */
export function extractTaskRequirements(task: {
  name: string;
  input?: unknown;
}): TaskRequirements {
  const taskType = task.name;
  let requiredTools: string[] = [];

  if (task.input && typeof task.input === "object" && !Array.isArray(task.input)) {
    const inputObj = task.input as Record<string, unknown>;
    const rawRequiredTools = inputObj["requiredTools"];
    const rawTools = inputObj["tools"];
    if (Array.isArray(rawRequiredTools)) {
      requiredTools = rawRequiredTools.filter(
        (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
      );
    } else if (Array.isArray(rawTools)) {
      requiredTools = rawTools.filter(
        (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
      );
    }
  }

  return {
    taskType,
    requiredTools,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Selection Failure Diagnostics & Result Contract
// ─────────────────────────────────────────────────────────────────────────────

export const workerSelectionFailureReasonSchema = z.enum([
  "NO_REGISTERED_WORKERS",
  "NO_HEALTHY_WORKERS",
  "NO_CAPABLE_WORKERS",
  "CAPACITY_EXHAUSTED",
]);
export type WorkerSelectionFailureReason = z.infer<
  typeof workerSelectionFailureReasonSchema
>;

export const WorkerSelectionFailureReasonEnum = {
  NO_REGISTERED_WORKERS: "NO_REGISTERED_WORKERS",
  NO_HEALTHY_WORKERS: "NO_HEALTHY_WORKERS",
  NO_CAPABLE_WORKERS: "NO_CAPABLE_WORKERS",
  CAPACITY_EXHAUSTED: "CAPACITY_EXHAUSTED",
} as const;

export const workerSelectionResultSchema = z.object({
  selectedWorker: workerDescriptorSchema.optional(),
  failureReason: workerSelectionFailureReasonSchema.optional(),
  evaluatedWorkerCount: z.number().int().nonnegative(),
  eligibleWorkerCount: z.number().int().nonnegative(),
});
export type WorkerSelectionResult = z.infer<typeof workerSelectionResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch Error Contracts & Codes
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchErrorCodeSchema = z.enum([
  "NO_ELIGIBLE_WORKER",
  "ASSIGNMENT_BUILD_FAILED",
  "TOPIC_PROVISION_FAILED",
  "DISPATCH_PUBLISH_FAILED",
  "INVALID_DISPATCH_REQUEST",
]);
export type DispatchErrorCode = z.infer<typeof dispatchErrorCodeSchema>;

export interface DispatchError {
  readonly code: DispatchErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function createDispatchError(
  code: DispatchErrorCode,
  message: string,
  cause?: unknown,
): DispatchError {
  return { code, message, cause };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch Result Contract (Outcome of Task Dispatching Attempt)
// ─────────────────────────────────────────────────────────────────────────────

export const dispatchResultStatusSchema = z.enum([
  "ASSIGNED",
  "NO_ELIGIBLE_WORKER",
  "DISPATCH_FAILED",
]);
export type DispatchResultStatus = z.infer<typeof dispatchResultStatusSchema>;

export const dispatchResultSchema = z.object({
  status: dispatchResultStatusSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  assignmentId: assignmentIdSchema.optional(),
  workerId: workerIdSchema.optional(),
  targetTopic: z.string().optional(),
  reason: workerSelectionFailureReasonSchema.optional(),
  error: z
    .object({
      code: dispatchErrorCodeSchema,
      message: z.string(),
    })
    .optional(),
});
export type DispatchResult = z.infer<typeof dispatchResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch Interfaces & Boundary Contracts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contract for selecting an eligible worker from a list of candidate descriptors.
 * Must be deterministic (Lock 7).
 */
export interface IWorkerSelector {
  selectWorker(
    task: Task,
    candidates: readonly WorkerDescriptor[],
    requirements?: TaskRequirements,
  ): WorkerSelectionResult;
}

/**
 * Contract for ensuring dedicated worker-targeted Kafka topics exist prior to use.
 */
export interface ITopicProvisioner {
  ensureTopic(
    topic: string,
    partitions?: number,
    replicationFactor?: number,
  ): Promise<Result<boolean, DispatchError>>;
}

/**
 * Contract for publishing a task assignment envelope to a worker-specific topic.
 */
export interface ITaskAssignmentPublisher {
  publish(
    targetTopic: string,
    envelope: TaskAssignmentEnvelope,
  ): Promise<Result<TaskAssignmentEnvelope, DispatchError>>;
}

/**
 * Operational options for a task dispatch invocation.
 */
export interface DispatchOptions {
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly runId?: RunId | undefined;
}

/**
 * Contract for orchestrating worker selection, envelope construction, topic provisioning,
 * and dispatch publication.
 */
export interface ITaskDispatcher {
  dispatch(task: Task, options?: DispatchOptions): Promise<DispatchResult>;
}
