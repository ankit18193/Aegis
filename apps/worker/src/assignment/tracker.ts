import type { AssignmentDecisionContract } from "@aegis/contracts";

export interface AssignmentTrackerOptions {
  /** Maximum number of assignment entries to keep in memory before evicting oldest. Default: 10,000. */
  readonly maxCapacity?: number | undefined;
}

/**
 * Bounded in-memory assignment tracker.
 * Provides process-local duplicate suppression and decision state tracking.
 * Evicts oldest entries once maxCapacity is reached to prevent memory leaks.
 */
export class AssignmentTracker {
  private readonly records = new Map<string, AssignmentDecisionContract>();
  private readonly maxCapacity: number;

  constructor(options: AssignmentTrackerOptions = {}) {
    this.maxCapacity =
      options.maxCapacity && options.maxCapacity > 0 ? options.maxCapacity : 10000;
  }

  /**
   * Records an assignment decision.
   */
  public record(decision: AssignmentDecisionContract): void {
    if (this.records.size >= this.maxCapacity && !this.records.has(decision.assignmentId)) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) {
        this.records.delete(oldestKey);
      }
    }

    this.records.set(decision.assignmentId, decision);
  }

  /**
   * Returns a previously recorded assignment decision if it exists.
   */
  public get(assignmentId: string): AssignmentDecisionContract | undefined {
    return this.records.get(assignmentId);
  }

  /**
   * Checks whether this assignmentId has already been recorded.
   */
  public isDuplicate(assignmentId: string): boolean {
    return this.records.has(assignmentId);
  }

  /**
   * Clears all recorded assignments.
   */
  public clear(): void {
    this.records.clear();
  }

  /**
   * Returns the count of currently tracked assignments.
   */
  public get size(): number {
    return this.records.size;
  }
}
