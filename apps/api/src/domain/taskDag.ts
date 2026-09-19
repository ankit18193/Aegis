/**
 * Pure directed acyclic graph (DAG) module for Aegis workflow tasks.
 * Validates graph integrity, checks dependencies, detects cycles, and provides topological ordering.
 */

import { ok, err, type Result } from "@aegis/types";
import {
  DagCycleError,
  DuplicateDependencyError,
  DuplicateTaskIdError,
  MissingDependencyError,
  SelfDependencyError,
} from "./errors.js";

export interface TaskNode {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly [key: string]: unknown;
}

export class TaskDag<T extends TaskNode = TaskNode> {
  private readonly tasksById: ReadonlyMap<string, T>;
  private readonly dependenciesByTaskId: ReadonlyMap<string, readonly string[]>;
  private readonly dependentsByTaskId: ReadonlyMap<string, readonly string[]>;
  private readonly topologicalOrder: readonly T[];

  private constructor(
    tasksById: Map<string, T>,
    dependenciesByTaskId: Map<string, string[]>,
    dependentsByTaskId: Map<string, string[]>,
    topologicalOrder: T[],
  ) {
    this.tasksById = tasksById;
    this.dependenciesByTaskId = dependenciesByTaskId;
    this.dependentsByTaskId = dependentsByTaskId;
    this.topologicalOrder = topologicalOrder;
  }

  /**
   * Constructs and validates a TaskDag from a collection of tasks.
   * Enforces:
   * - INV-DAG-01: Unique task IDs
   * - INV-DAG-02: Existing dependency references
   * - INV-DAG-03: No self-dependencies
   * - INV-DAG-04: No duplicate dependencies
   * - Acyclicity via depth-first cycle detection and Kahn's topological sort
   */
  static build<T extends TaskNode>(
    tasks: readonly T[],
  ): Result<
    TaskDag<T>,
    | DuplicateTaskIdError
    | SelfDependencyError
    | DuplicateDependencyError
    | MissingDependencyError
    | DagCycleError
  > {
    const tasksById = new Map<string, T>();
    const dependenciesByTaskId = new Map<string, string[]>();
    const dependentsByTaskId = new Map<string, string[]>();

    // 1. INV-DAG-01: Ensure unique task IDs and initialize maps
    for (const task of tasks) {
      if (tasksById.has(task.id)) {
        return err(new DuplicateTaskIdError(task.id));
      }
      tasksById.set(task.id, task);
      dependenciesByTaskId.set(task.id, []);
      dependentsByTaskId.set(task.id, []);
    }

    // 2. Validate dependencies
    for (const task of tasks) {
      const deps = task.dependencies ?? [];
      const seenDeps = new Set<string>();

      for (const depId of deps) {
        // INV-DAG-03: No self-dependency
        if (depId === task.id) {
          return err(new SelfDependencyError(task.id));
        }

        // INV-DAG-04: No duplicate dependencies
        if (seenDeps.has(depId)) {
          return err(new DuplicateDependencyError(task.id, depId));
        }
        seenDeps.add(depId);

        // INV-DAG-02: Dependency must exist in the workflow
        if (!tasksById.has(depId)) {
          return err(new MissingDependencyError(task.id, depId));
        }

        dependenciesByTaskId.get(task.id)!.push(depId);
        dependentsByTaskId.get(depId)!.push(task.id);
      }
    }

    // 3. Cycle Detection via DFS with recursion stack tracking
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];
    let cyclePath: string[] | null = null;

    function dfs(nodeId: string): boolean {
      visited.add(nodeId);
      inStack.add(nodeId);
      stack.push(nodeId);

      const deps = dependenciesByTaskId.get(nodeId) ?? [];
      for (const depId of deps) {
        if (inStack.has(depId)) {
          const startIndex = stack.indexOf(depId);
          cyclePath = [...stack.slice(startIndex), depId];
          return true;
        }
        if (!visited.has(depId)) {
          if (dfs(depId)) {
            return true;
          }
        }
      }

      stack.pop();
      inStack.delete(nodeId);
      return false;
    }

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        if (dfs(task.id)) {
          return err(new DagCycleError(cyclePath!));
        }
      }
    }

    // 4. Deterministic Kahn's Topological Sort (precedence order: dependencies before dependents)
    const prereqCounts = new Map<string, number>();
    const readyQueue: T[] = [];

    for (const task of tasks) {
      const prereqs = dependenciesByTaskId.get(task.id)!.length;
      prereqCounts.set(task.id, prereqs);
      if (prereqs === 0) {
        readyQueue.push(task);
      }
    }

    const topologicalOrder: T[] = [];
    while (readyQueue.length > 0) {
      const current = readyQueue.shift()!;
      topologicalOrder.push(current);

      const dependents = dependentsByTaskId.get(current.id) ?? [];
      for (const dependentId of dependents) {
        const remaining = prereqCounts.get(dependentId)! - 1;
        prereqCounts.set(dependentId, remaining);
        if (remaining === 0) {
          readyQueue.push(tasksById.get(dependentId)!);
        }
      }
    }

    return ok(
      new TaskDag(
        tasksById,
        dependenciesByTaskId,
        dependentsByTaskId,
        topologicalOrder,
      ),
    );
  }

  get size(): number {
    return this.tasksById.size;
  }

  getTasks(): readonly T[] {
    return Array.from(this.tasksById.values());
  }

  getTask(id: string): T | undefined {
    return this.tasksById.get(id);
  }

  hasTask(id: string): boolean {
    return this.tasksById.has(id);
  }

  getTopologicalOrder(): readonly T[] {
    return this.topologicalOrder;
  }

  getDependencies(id: string): readonly string[] {
    return this.dependenciesByTaskId.get(id) ?? [];
  }

  getDependents(id: string): readonly string[] {
    return this.dependentsByTaskId.get(id) ?? [];
  }

  getRootTasks(): readonly T[] {
    return this.topologicalOrder.filter(
      (task) => (this.dependenciesByTaskId.get(task.id)?.length ?? 0) === 0,
    );
  }

  getLeafTasks(): readonly T[] {
    return this.topologicalOrder.filter(
      (task) => (this.dependentsByTaskId.get(task.id)?.length ?? 0) === 0,
    );
  }
}
