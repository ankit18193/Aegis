import { randomUUID } from "node:crypto";

import type {
  Task,
  TaskAssignment,
  TaskAssignmentEnvelope,
} from "@aegis/contracts";
import type { RunId, WorkerId } from "@aegis/types";
import { assignmentId, eventId, runId } from "@aegis/types";

export interface BuildAssignmentParams {
  readonly task: Task;
  readonly workerId: WorkerId;
  readonly runId?: RunId | undefined;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly assignedAt?: string | undefined;
}

export interface BuiltAssignment {
  readonly assignment: TaskAssignment;
  readonly envelope: TaskAssignmentEnvelope;
}

/**
 * Constructs a canonical TaskAssignment and CloudEvents-compliant TaskAssignmentEnvelope.
 *
 * Enforces Lock 9 Invariant:
 * Distinct Branded Identifiers: TaskId ≠ AssignmentId ≠ WorkerId ≠ RunId.
 * Each invocation mints a unique AssignmentId ('asgn-${uuid}') and EventId ('evt-${uuid}').
 */
export function buildTaskAssignment(params: BuildAssignmentParams): BuiltAssignment {
  const generatedAssignmentId = assignmentId(`asgn-${randomUUID()}`);
  const assignedAt = params.assignedAt ?? new Date().toISOString();
  const effectiveRunId = params.runId ?? runId(`run-${randomUUID()}`);
  const correlationId = params.correlationId ?? `corr-${randomUUID()}`;

  const assignment: TaskAssignment = {
    assignmentId: generatedAssignmentId,
    taskId: params.task.id,
    runId: effectiveRunId,
    workerId: params.workerId,
    task: params.task,
    assignedAt,
  };

  const envelope: TaskAssignmentEnvelope = {
    id: eventId(`evt-${randomUUID()}`),
    type: "task_assigned",
    source: "aegis.control_plane.dispatcher",
    specVersion: "1.0",
    time: assignedAt,
    aggregateId: params.task.id,
    aggregateType: "TaskAssignment",
    correlationId,
    causationId: params.causationId,
    data: assignment,
  };

  return { assignment, envelope };
}
