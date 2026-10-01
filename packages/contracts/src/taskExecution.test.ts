import { assignmentId, eventId, ok, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { ITaskExecutor, ITaskResultPublisher } from "./taskExecution.js";
import {
  createTaskExecutionError,
  taskExecutionContextSchema,
  taskExecutionErrorCodeSchema,
  taskExecutionErrorSchema,
  taskExecutionResultSchema,
  taskResultEnvelopeSchema,
  taskResultStatusSchema,
  TaskResultStatusValue,
} from "./taskExecution.js";

describe("Task Execution Contracts & Schemas (Phase 11C — Commit 1)", () => {
  describe("TaskExecutionContext", () => {
    it("validates a well-formed execution context", () => {
      const context = {
        workerId: workerId("worker-1"),
        taskId: taskId("task-100"),
        runId: runId("run-200"),
        assignmentId: assignmentId("assign-300"),
        startedAt: new Date().toISOString(),
      };

      const parsed = taskExecutionContextSchema.parse(context);
      expect(parsed.workerId).toBe("worker-1");
      expect(parsed.taskId).toBe("task-100");
      expect(parsed.runId).toBe("run-200");
      expect(parsed.assignmentId).toBe("assign-300");
    });

    it("rejects execution context with invalid datetime or missing identities", () => {
      expect(() =>
        taskExecutionContextSchema.parse({
          workerId: "worker-1",
          taskId: "task-100",
          runId: "run-200",
          assignmentId: "assign-300",
          startedAt: "not-a-datetime",
        }),
      ).toThrow();

      expect(() =>
        taskExecutionContextSchema.parse({
          workerId: "",
          taskId: "task-100",
          runId: "run-200",
          assignmentId: "assign-300",
          startedAt: new Date().toISOString(),
        }),
      ).toThrow();
    });
  });

  describe("TaskResultStatus and TaskExecutionError", () => {
    it("validates SUCCEEDED and FAILED result statuses", () => {
      expect(taskResultStatusSchema.parse(TaskResultStatusValue.SUCCEEDED)).toBe("SUCCEEDED");
      expect(taskResultStatusSchema.parse(TaskResultStatusValue.FAILED)).toBe("FAILED");
      expect(() => taskResultStatusSchema.parse("PENDING")).toThrow();
      expect(() => taskResultStatusSchema.parse("COMPLETED")).toThrow();
    });

    it("validates structured task execution error schema and factory", () => {
      const err = createTaskExecutionError(
        "TASK_EXECUTION_FAILED",
        "Action calculator failed due to division by zero",
        { divisor: 0 },
        "Error: division by zero\n    at Calculator.eval",
      );

      const parsed = taskExecutionErrorSchema.parse(err);
      expect(parsed.code).toBe("TASK_EXECUTION_FAILED");
      expect(parsed.message).toContain("division by zero");
      expect(parsed.details).toEqual({ divisor: 0 });
      expect(parsed.stack).toContain("Calculator.eval");
      expect(taskExecutionErrorCodeSchema.parse(parsed.code)).toBe("TASK_EXECUTION_FAILED");
    });

    it("validates all canonical error codes", () => {
      const codes = [
        "TASK_EXECUTION_FAILED",
        "TASK_EXECUTION_TIMEOUT",
        "TASK_RUNTIME_ERROR",
        "TASK_RESULT_SERIALIZATION_FAILED",
        "TASK_RESULT_PUBLICATION_FAILED",
      ] as const;

      for (const code of codes) {
        expect(taskExecutionErrorCodeSchema.parse(code)).toBe(code);
      }
    });
  });

  describe("TaskExecutionResult", () => {
    it("validates a successful execution result payload", () => {
      const result = {
        taskId: taskId("task-1"),
        runId: runId("run-1"),
        assignmentId: assignmentId("assign-1"),
        workerId: workerId("worker-1"),
        status: TaskResultStatusValue.SUCCEEDED,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: { answer: 42, summary: "Calculation complete" },
      };

      const parsed = taskExecutionResultSchema.parse(result);
      expect(parsed.status).toBe("SUCCEEDED");
      expect(parsed.output).toEqual({ answer: 42, summary: "Calculation complete" });
      expect(parsed.error).toBeUndefined();
    });

    it("validates a failed execution result payload with structured error", () => {
      const result = {
        taskId: taskId("task-2"),
        runId: runId("run-1"),
        assignmentId: assignmentId("assign-2"),
        workerId: workerId("worker-1"),
        status: TaskResultStatusValue.FAILED,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: {
          code: "TASK_RUNTIME_ERROR",
          message: "Agent exceeded maximum iteration limit (10)",
        },
      };

      const parsed = taskExecutionResultSchema.parse(result);
      expect(parsed.status).toBe("FAILED");
      expect(parsed.error?.code).toBe("TASK_RUNTIME_ERROR");
      expect(parsed.error?.message).toContain("maximum iteration limit");
    });

    it("rejects execution result with invalid dates or missing identities", () => {
      expect(() =>
        taskExecutionResultSchema.parse({
          taskId: "task-1",
          runId: "run-1",
          assignmentId: "assign-1",
          workerId: "worker-1",
          status: "SUCCEEDED",
          startedAt: "invalid-date",
          completedAt: new Date().toISOString(),
        }),
      ).toThrow();
    });
  });

  describe("TaskResultEnvelope", () => {
    it("validates canonical TaskResultEnvelope with CloudEvents metadata", () => {
      const envelope = {
        id: eventId("evt-result-1"),
        type: "task_result",
        source: "aegis.worker.worker-1",
        specVersion: "1.0",
        time: new Date().toISOString(),
        aggregateId: taskId("task-100"),
        aggregateType: "TaskResult",
        correlationId: "corr-run-200",
        causationId: "cause-assign-300",
        data: {
          taskId: taskId("task-100"),
          runId: runId("run-200"),
          assignmentId: assignmentId("assign-300"),
          workerId: workerId("worker-1"),
          status: TaskResultStatusValue.SUCCEEDED,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          output: "Task executed successfully",
        },
      };

      const parsed = taskResultEnvelopeSchema.parse(envelope);
      expect(parsed.id).toBe("evt-result-1");
      expect(parsed.type).toBe("task_result");
      expect(parsed.aggregateType).toBe("TaskResult");
      expect(parsed.data.taskId).toBe("task-100");
    });

    it("rejects envelope with invalid type or aggregateType", () => {
      expect(() =>
        taskResultEnvelopeSchema.parse({
          id: eventId("evt-1"),
          type: "task_assigned", // invalid for result envelope
          source: "aegis.worker",
          specVersion: "1.0",
          time: new Date().toISOString(),
          aggregateId: taskId("task-1"),
          aggregateType: "TaskResult",
          correlationId: "corr-1",
          data: {},
        }),
      ).toThrow();

      expect(() =>
        taskResultEnvelopeSchema.parse({
          id: eventId("evt-1"),
          type: "task_result",
          source: "aegis.worker",
          specVersion: "1.0",
          time: new Date().toISOString(),
          aggregateId: taskId("task-1"),
          aggregateType: "ExecutionRun", // invalid aggregateType for task result
          correlationId: "corr-1",
          data: {},
        }),
      ).toThrow();
    });
  });

  describe("Identity Preservation Invariants", () => {
    it("ensures eventId, taskId, assignmentId, runId, and workerId remain distinct branded types", () => {
      const eId = eventId("evt-result-99");
      const tId = taskId("task-42");
      const aId = assignmentId("assign-10");
      const rId = runId("run-7");
      const wId = workerId("worker-alpha");

      const result = {
        taskId: tId,
        runId: rId,
        assignmentId: aId,
        workerId: wId,
        status: TaskResultStatusValue.SUCCEEDED,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const envelope = {
        id: eId,
        type: "task_result" as const,
        source: `aegis.worker.${wId}`,
        specVersion: "1.0" as const,
        time: new Date().toISOString(),
        aggregateId: tId,
        aggregateType: "TaskResult" as const,
        correlationId: `corr-${rId}`,
        causationId: `cause-${aId}`,
        data: result,
      };

      const parsedEnvelope = taskResultEnvelopeSchema.parse(envelope);

      // Verify identities do NOT collapse into one another
      expect(parsedEnvelope.id).toBe("evt-result-99");
      expect(parsedEnvelope.aggregateId).toBe("task-42");
      expect(parsedEnvelope.data.taskId).toBe("task-42");
      expect(parsedEnvelope.data.assignmentId).toBe("assign-10");
      expect(parsedEnvelope.data.runId).toBe("run-7");
      expect(parsedEnvelope.data.workerId).toBe("worker-alpha");

      expect(parsedEnvelope.id).not.toBe(parsedEnvelope.aggregateId);
      expect(parsedEnvelope.data.taskId).not.toBe(parsedEnvelope.data.assignmentId);
      expect(parsedEnvelope.data.assignmentId).not.toBe(parsedEnvelope.data.runId);
    });
  });

  describe("Interface Conformance", () => {
    it("allows mocking ITaskExecutor and ITaskResultPublisher matching the canonical contracts", async () => {
      const mockExecutor: ITaskExecutor = {
        execute(assignment, context) {
          return Promise.resolve({
            taskId: assignment.taskId,
            runId: assignment.runId,
            assignmentId: context.assignmentId,
            workerId: context.workerId,
            status: TaskResultStatusValue.SUCCEEDED,
            startedAt: context.startedAt,
            completedAt: new Date().toISOString(),
            output: "mock-output",
          });
        },
      };

      const mockPublisher: ITaskResultPublisher = {
        publish(result, metadata) {
          return Promise.resolve(
            ok({
              id: eventId("mock-evt-1"),
              type: "task_result",
              source: `aegis.worker.${result.workerId}`,
              specVersion: "1.0",
              time: new Date().toISOString(),
              aggregateId: result.taskId,
              aggregateType: "TaskResult",
              correlationId: metadata?.correlationId ?? "corr-default",
              causationId: metadata?.causationId,
              data: result,
            }),
          );
        },
      };

      const execResult = await mockExecutor.execute(
        {
          assignmentId: assignmentId("assign-1"),
          taskId: taskId("task-1"),
          runId: runId("run-1"),
          workerId: workerId("worker-1"),
          task: {
            id: taskId("task-1"),
            name: "Test task",
            status: "pending",
            description: "",
            attemptCount: 0,
          },
          assignedAt: new Date().toISOString(),
        },
        {
          workerId: workerId("worker-1"),
          taskId: taskId("task-1"),
          runId: runId("run-1"),
          assignmentId: assignmentId("assign-1"),
          startedAt: new Date().toISOString(),
        },
      );

      const pubResult = await mockPublisher.publish(execResult, {
        correlationId: "corr-1",
        causationId: "assign-1",
      });

      expect(pubResult.ok).toBe(true);
      if (pubResult.ok) {
        expect(pubResult.value.data.status).toBe("SUCCEEDED");
        expect(pubResult.value.aggregateType).toBe("TaskResult");
      }
    });
  });
});
