import type {
  AssignmentDecisionContract,
  AssignmentErrorContract,
  TaskAssignment,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";

/**
 * Validated task assignment container with target matching flag.
 */
export interface ValidatedAssignment {
  readonly assignment: TaskAssignment;
  readonly isTargeted: boolean;
}

export type AssignmentValidationResult = Result<
  ValidatedAssignment,
  AssignmentErrorContract
>;

export type AssignmentHandlingResult = Result<
  AssignmentDecisionContract,
  AssignmentErrorContract
>;
