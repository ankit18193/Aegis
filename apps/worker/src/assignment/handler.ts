import type {
  AssignmentDecisionContract,
  TaskAssignment,
} from "@aegis/contracts";
import {
  createAssignmentError,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { err, ok } from "@aegis/types";

import type { AssignmentTracker } from "./tracker.js";
import type { AssignmentHandlingResult } from "./types.js";
import type { TaskAssignmentValidator } from "./validator.js";

export interface TaskAssignmentHandlerOptions {
  readonly validator: TaskAssignmentValidator;
  readonly tracker: AssignmentTracker;
  readonly logger?: Logger | undefined;
}

/**
 * Orchestrates task assignment validation, deduplication, and local acceptance.
 */
export class TaskAssignmentHandler {
  private readonly validator: TaskAssignmentValidator;
  private readonly tracker: AssignmentTracker;
  private readonly logger?: Logger | undefined;

  constructor(options: TaskAssignmentHandlerOptions) {
    this.validator = options.validator;
    this.tracker = options.tracker;
    this.logger = options.logger;
  }

  /**
   * Processes an incoming task assignment.
   *
   * Outlined semantics:
   * 1. If not targeted to this worker: returns ok({ status: "ignored_not_targeted" }).
   *    Note: Target-worker routing is not guaranteed by the shared consumer group in 11B;
   *    mismatched messages are acknowledged/committed to avoid head-of-line blocking,
   *    recorded as "ignored_not_targeted", and never treated as successful acceptance.
   *    Dynamic scheduling/routing is finalized in 11D/11E.
   * 2. If duplicate assignmentId: returns err("DUPLICATE_ASSIGNMENT").
   * 3. If capability mismatch: records and returns ok({ status: "rejected" }).
   * 4. If valid & targeted: records and returns ok({ status: "accepted" }).
   */
  public handleAssignment(
    assignment: TaskAssignment,
  ): AssignmentHandlingResult {
    // 1. Target check
    const targetCheck = this.validator.validateTarget(assignment);
    if (!targetCheck.isTargeted) {
      this.logger?.info("Assignment not targeted to this worker; ignoring", {
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        targetedWorkerId: assignment.workerId,
        reason: targetCheck.reason,
      });

      const decision: AssignmentDecisionContract = {
        status: "ignored_not_targeted",
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        runId: assignment.runId,
        workerId: assignment.workerId,
        reason: targetCheck.reason,
      };

      return ok(decision);
    }

    // 2. Deduplication check
    if (this.tracker.isDuplicate(assignment.assignmentId)) {
      const existing = this.tracker.get(assignment.assignmentId);
      const statusText = existing?.status ?? "unknown";
      this.logger?.warn("Duplicate assignment received; suppressing", {
        assignmentId: assignment.assignmentId,
        existingStatus: statusText,
      });

      return err(
        createAssignmentError(
          "DUPLICATE_ASSIGNMENT",
          `Assignment '${assignment.assignmentId}' has already been processed with status '${statusText}'.`,
        ),
      );
    }

    // 3. Capabilities check
    const capResult = this.validator.validateCapabilities(assignment);
    if (!capResult.ok) {
      this.logger?.warn("Assignment capability mismatch", {
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        error: capResult.error.message,
      });

      const decision: AssignmentDecisionContract = {
        status: "rejected",
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        runId: assignment.runId,
        workerId: assignment.workerId,
        reason: capResult.error.message,
      };

      this.tracker.record(decision);
      return ok(decision);
    }

    // 4. Acceptance
    const decision: AssignmentDecisionContract = {
      status: "accepted",
      assignmentId: assignment.assignmentId,
      taskId: assignment.taskId,
      runId: assignment.runId,
      workerId: assignment.workerId,
    };

    this.tracker.record(decision);
    this.logger?.info("Task assignment accepted", {
      assignmentId: assignment.assignmentId,
      taskId: assignment.taskId,
      runId: assignment.runId,
    });

    return ok(decision);
  }
}
