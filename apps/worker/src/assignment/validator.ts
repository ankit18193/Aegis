import type {
  AssignmentErrorContract,
  TaskAssignment,
  WorkerCapabilities,
} from "@aegis/contracts";
import {
  createAssignmentError,
  taskAssignmentSchema,
} from "@aegis/contracts";
import type { Result, WorkerId } from "@aegis/types";
import { err, ok } from "@aegis/types";

export interface TaskAssignmentValidatorOptions {
  readonly workerId: WorkerId;
  readonly capabilities: WorkerCapabilities;
}

export interface TargetValidationResult {
  readonly isTargeted: boolean;
  readonly reason?: string | undefined;
}

/**
 * Validates task assignments against worker identity, targeting, and capabilities.
 */
export class TaskAssignmentValidator {
  private readonly workerId: WorkerId;
  private readonly capabilities: WorkerCapabilities;

  constructor(options: TaskAssignmentValidatorOptions) {
    this.workerId = options.workerId;
    this.capabilities = options.capabilities;
  }

  /**
   * Validates raw payload against canonical TaskAssignment schema.
   */
  public validateSchema(payload: unknown): Result<TaskAssignment, AssignmentErrorContract> {
    const parseResult = taskAssignmentSchema.safeParse(payload);
    if (!parseResult.success) {
      return err(
        createAssignmentError(
          "INVALID_ASSIGNMENT_ENVELOPE",
          `Task assignment payload schema validation failed: ${parseResult.error.message}`,
          parseResult.error,
        ),
      );
    }
    return ok(parseResult.data);
  }

  /**
   * Checks whether the assignment is strictly targeted to this worker.
   *
   * ARCHITECTURAL NOTE (Phase 11B):
   * Target-worker routing is NOT yet guaranteed by the shared Kafka consumer group
   * (`aegis-workers`), which routes partitions rather than specific worker targets.
   * When an assignment's workerId does not match this worker, 11B explicitly models this
   * as a non-targeted outcome (`isTargeted: false`) rather than an execution failure.
   * The actual dynamic routing and scheduling strategy will be finalized in 11D/11E.
   */
  public validateTarget(assignment: TaskAssignment): TargetValidationResult {
    if (!assignment.workerId) {
      return {
        isTargeted: false,
        reason: "Assignment workerId is omitted; Phase 11B requires explicit worker targeting.",
      };
    }

    if (assignment.workerId !== this.workerId) {
      return {
        isTargeted: false,
        reason: `Assignment targeted to worker '${assignment.workerId}', current worker is '${this.workerId}'.`,
      };
    }

    return { isTargeted: true };
  }

  /**
   * Checks whether this worker supports the capabilities required by the task.
   */
  public validateCapabilities(
    assignment: TaskAssignment,
  ): Result<void, AssignmentErrorContract> {
    const supportedTypes = this.capabilities.taskTypes;

    // Wildcard '*' capability accepts all task types
    if (supportedTypes.includes("*")) {
      return ok(undefined);
    }

    const taskName = assignment.task.name;
    const isSupported = supportedTypes.some(
      (type) => type.toLowerCase() === taskName.toLowerCase(),
    );

    if (!isSupported) {
      return err(
        createAssignmentError(
          "ASSIGNMENT_CAPABILITY_MISMATCH",
          `Worker '${this.workerId}' does not support task type '${taskName}'. Supported types: [${supportedTypes.join(", ")}].`,
        ),
      );
    }

    return ok(undefined);
  }
}
