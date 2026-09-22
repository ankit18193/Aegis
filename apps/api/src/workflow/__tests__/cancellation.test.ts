import { runId, taskId, workflowId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { CreateRunProps } from "../../domain/run.js";
import { ExecutionRun } from "../../domain/run.js";
import { TaskEntity } from "../../domain/task.js";
import { WorkflowEngine } from "../engine.js";
import { WorkflowCancelledError } from "../errors.js";
import type { ITaskExecutor, WorkflowDefinition } from "../types.js";

function mustCreateRun(props: CreateRunProps): ExecutionRun {
  const res = ExecutionRun.create(props);
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  return res.value;
}

describe("Workflow Cancellation & Terminal State Protection", () => {
  const engine = new WorkflowEngine();

  it("cancels execution before any task starts if signal is already aborted", async () => {
    const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
    const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

    const run = mustCreateRun({
      id: runId("run-cancel-pre"),
      goal: "Pre-cancelled run",
      workflow: { id: workflowId("wf-1"), name: "PreCancel" },
      tasks: [taskA, taskB],
    });

    const workflow: WorkflowDefinition = {
      id: workflowId("wf-1"),
      name: "PreCancel",
      tasks: [
        { id: taskId("A"), name: "Task A" },
        { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
      ],
    };

    const controller = new AbortController();
    controller.abort("User aborted before start");

    const result = await engine.execute(workflow, run, {
      abortSignal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(run.status).toBe("cancelled");
    expect(run.getTask("A")?.status).toBe("cancelled");
    expect(run.getTask("B")?.status).toBe("cancelled");
  });

  it("propagates AbortSignal to in-flight task and halts downstream scheduling", async () => {
    const controller = new AbortController();

    const cancellableExecutor: ITaskExecutor = {
      execute: async (input, signal) => {
        if (input.taskId === "A") {
          // Trigger cancellation while task A is executing
          controller.abort("Cancellation mid-task");

          if (signal?.aborted) {
            return {
              taskId: input.taskId,
              success: false,
              error: "Task A aborted by signal",
              durationMs: 5,
            };
          }
        }
        return {
          taskId: input.taskId,
          success: true,
          output: "Success",
          durationMs: 5,
        };
      },
    };

    const cancellableEngine = new WorkflowEngine({
      taskExecutor: cancellableExecutor,
    });

    const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
    const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

    const run = mustCreateRun({
      id: runId("run-cancel-mid"),
      goal: "Mid-execution cancellation",
      workflow: { id: workflowId("wf-mid"), name: "Mid" },
      tasks: [taskA, taskB],
    });

    const workflow: WorkflowDefinition = {
      id: workflowId("wf-mid"),
      name: "Mid",
      tasks: [
        { id: taskId("A"), name: "Task A" },
        { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
      ],
    };

    const result = await cancellableEngine.execute(workflow, run, {
      abortSignal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(run.status).toBe("cancelled");
    // Downstream task B was never started and transitioned to cancelled by cascading cancel
    expect(run.getTask("B")?.status).toBe("cancelled");
  });

  it("enforces terminal-state-wins: completed run cannot be transitioned to cancelled", async () => {
    const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });

    const run = mustCreateRun({
      id: runId("run-term-wins"),
      goal: "Terminal state wins",
      workflow: { id: workflowId("wf-term"), name: "Term" },
      tasks: [taskA],
    });

    const workflow: WorkflowDefinition = {
      id: workflowId("wf-term"),
      name: "Term",
      tasks: [{ id: taskId("A"), name: "Task A" }],
    };

    // Execute to completion
    const result = await engine.execute(workflow, run);
    expect(result.ok).toBe(true);
    expect(run.status).toBe("completed");

    // Late cancel attempt
    const cancelResult = run.cancel("Late cancel");
    expect(cancelResult.ok).toBe(false);
    expect(run.status).toBe("completed");
  });

  it("handles duplicate terminal cancel operations gracefully without state corruption", async () => {
    const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
    const run = mustCreateRun({
      id: runId("run-dup-cancel"),
      goal: "Duplicate cancel",
      workflow: { id: workflowId("wf-dup"), name: "Dup" },
      tasks: [taskA],
    });

    const firstCancel = run.cancel("Operator cancel 1");
    expect(firstCancel.ok).toBe(true);
    expect(run.status).toBe("cancelled");

    // Second cancel attempt
    const secondCancel = run.cancel("Operator cancel 2");
    expect(secondCancel.ok).toBe(false);
    expect(run.status).toBe("cancelled");
  });
});
