import { runId, taskId, workflowId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { CreateRunProps } from "../../domain/run.js";
import { ExecutionRun } from "../../domain/run.js";
import { TaskEntity } from "../../domain/task.js";
import { WorkflowEngine } from "../engine.js";
import { WorkflowTaskExecutor } from "../task-executor.js";
import type { ITaskExecutor, WorkflowDefinition } from "../types.js";

function mustCreateRun(props: CreateRunProps): ExecutionRun {
  const res = ExecutionRun.create(props);
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  return res.value;
}

describe("WorkflowEngine Lifecycle Orchestration", () => {
  const engine = new WorkflowEngine();

  describe("Happy path DAG executions", () => {
    it("executes a single-task workflow to completion", async () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Solo Task",
        description: "Execute single unit",
      });

      const run = mustCreateRun({
        id: runId("run-single"),
        goal: "Run solo task",
        workflow: { id: workflowId("wf-1"), name: "Single" },
        tasks: [task],
      });

      const workflow: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Single",
        tasks: [{ id: taskId("task-1"), name: "Solo Task", description: "Execute single unit" }],
      };

      const result = await engine.execute(workflow, run);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("completed");
        expect(result.value.tasksTotal).toBe(1);
        expect(result.value.tasksCompleted).toBe(1);
        expect(result.value.tasksFailed).toBe(0);
      }
      expect(run.status).toBe("completed");
      expect(run.getTask("task-1")?.status).toBe("completed");
    });

    it("executes a multi-task linear pipeline in strict sequence (A -> B -> C)", async () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("B")] });

      const run = mustCreateRun({
        id: runId("run-linear"),
        goal: "Linear execution",
        workflow: { id: workflowId("wf-linear"), name: "Linear" },
        tasks: [taskA, taskB, taskC],
      });

      const workflow: WorkflowDefinition = {
        id: workflowId("wf-linear"),
        name: "Linear",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };

      const executionOrder: string[] = [];

      const result = await engine.execute(workflow, run, {
        onTaskStarted: (t) => {
          executionOrder.push(t.id);
        },
      });

      expect(result.ok).toBe(true);
      expect(executionOrder).toEqual(["A", "B", "C"]);
      expect(run.status).toBe("completed");
      expect(run.tasks.every((t) => t.status === "completed")).toBe(true);
    });

    it("executes a diamond DAG (A -> B, C -> D) to full completion", async () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("A")] });
      const taskD = TaskEntity.create({
        id: taskId("D"),
        name: "Task D",
        dependencies: [taskId("B"), taskId("C")],
      });

      const run = mustCreateRun({
        id: runId("run-diamond"),
        goal: "Diamond execution",
        workflow: { id: workflowId("wf-diamond"), name: "Diamond" },
        tasks: [taskA, taskB, taskC, taskD],
      });

      const workflow: WorkflowDefinition = {
        id: workflowId("wf-diamond"),
        name: "Diamond",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("A")] },
          { id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] },
        ],
      };

      const result = await engine.execute(workflow, run);

      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.calculateProgress()).toBe(100);
      expect(run.getTask("D")?.status).toBe("completed");
    });
  });

  describe("Failure propagation & downstream blocking (LOCK 6 & Correction #2)", () => {
    it("halts execution, blocks downstream tasks, and fails run when a task fails", async () => {
      const mockFailingExecutor: ITaskExecutor = {
        execute: async (input) => {
          if (input.taskId === "A") {
            return {
              taskId: input.taskId,
              success: false,
              error: "Critical processing failure in Task A",
              durationMs: 5,
            };
          }
          return {
            taskId: input.taskId,
            success: true,
            output: "Success",
            durationMs: 5,
          };
        },
      };

      const failingEngine = new WorkflowEngine({
        taskExecutor: mockFailingExecutor,
      });

      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("B")] });

      const run = mustCreateRun({
        id: runId("run-fail"),
        goal: "Failure propagation",
        workflow: { id: workflowId("wf-fail"), name: "Failure" },
        tasks: [taskA, taskB, taskC],
      });

      const workflow: WorkflowDefinition = {
        id: workflowId("wf-fail"),
        name: "Failure",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };

      const result = await failingEngine.execute(workflow, run);

      expect(result.ok).toBe(false);
      expect(run.status).toBe("failed");
      expect(run.getTask("A")?.status).toBe("failed");
      // Downstream tasks B and C were never started
      expect(run.getTask("B")?.status).toBe("pending");
      expect(run.getTask("C")?.status).toBe("pending");
    });
  });

  describe("Terminal state protection", () => {
    it("rejects execution on an already completed run", async () => {
      const task = TaskEntity.create({ id: taskId("t1"), name: "T1" });
      const run = mustCreateRun({
        id: runId("run-term"),
        goal: "Terminal protection",
        workflow: { id: workflowId("wf-term"), name: "Term" },
        tasks: [task],
      });

      run.start();
      run.scheduleTask(taskId("t1"));
      run.startTask(taskId("t1"));
      run.completeTask(taskId("t1"), "Done");
      run.complete();

      const workflow: WorkflowDefinition = {
        id: workflowId("wf-term"),
        name: "Term",
        tasks: [{ id: taskId("t1"), name: "T1" }],
      };

      const result = await engine.execute(workflow, run);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_WORKFLOW");
        expect(result.error.message).toContain("terminal status");
      }
    });
  });
});
