import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  createDispatchError,
  dispatchErrorCodeSchema,
  dispatchResultSchema,
  extractTaskRequirements,
  resolveWorkerAssignmentTopic,
  taskRequirementsSchema,
  WorkerSelectionFailureReasonEnum,
  workerSelectionFailureReasonSchema,
  workerSelectionResultSchema,
  type DispatchError,
  type DispatchResult,
  type ITaskAssignmentPublisher,
  type ITaskDispatcher,
  type ITopicProvisioner,
  type IWorkerSelector,
  type WorkerDescriptor,
} from "./index.js";

describe("Phase 11E: Task Dispatch Contracts & Topic Routing", () => {
  describe("resolveWorkerAssignmentTopic", () => {
    it("resolves worker-targeted topic with standard base and workerId", () => {
      const topic = resolveWorkerAssignmentTopic(
        "aegis.tasks.assign",
        workerId("worker-42"),
      );
      expect(topic).toBe("aegis.tasks.assign.worker-42");
    });

    it("trims whitespace from base topic and workerId", () => {
      const topic = resolveWorkerAssignmentTopic(
        "  aegis.tasks.assign  ",
        workerId("  worker-node-1  "),
      );
      expect(topic).toBe("aegis.tasks.assign.worker-node-1");
    });

    it("throws when workerId is empty or whitespace (zero unrouted fallback)", () => {
      expect(() =>
        resolveWorkerAssignmentTopic("aegis.tasks.assign", workerId("")),
      ).toThrowError(/workerId is required and must be non-empty/);

      expect(() =>
        resolveWorkerAssignmentTopic("aegis.tasks.assign", workerId("   ")),
      ).toThrowError(/workerId is required and must be non-empty/);
    });

    it("throws when baseTopic is empty or whitespace", () => {
      expect(() =>
        resolveWorkerAssignmentTopic("", workerId("worker-1")),
      ).toThrowError(/baseTopic must be a non-empty string/);

      expect(() =>
        resolveWorkerAssignmentTopic("   ", workerId("worker-1")),
      ).toThrowError(/baseTopic must be a non-empty string/);
    });
  });

  describe("extractTaskRequirements", () => {
    it("extracts task.name as taskType with empty requiredTools by default", () => {
      const req = extractTaskRequirements({
        name: "data_analysis",
      });
      expect(req).toEqual({
        taskType: "data_analysis",
        requiredTools: [],
      });
    });

    it("extracts requiredTools from task.input.requiredTools", () => {
      const req = extractTaskRequirements({
        name: "web_scraping",
        input: {
          url: "https://example.com",
          requiredTools: ["http_client", "html_parser"],
        },
      });
      expect(req).toEqual({
        taskType: "web_scraping",
        requiredTools: ["http_client", "html_parser"],
      });
    });

    it("extracts requiredTools from task.input.tools fallback", () => {
      const req = extractTaskRequirements({
        name: "code_execution",
        input: {
          code: "console.log('hi')",
          tools: ["bash", "python"],
        },
      });
      expect(req).toEqual({
        taskType: "code_execution",
        requiredTools: ["bash", "python"],
      });
    });

    it("ignores non-string or whitespace-only tools", () => {
      const req = extractTaskRequirements({
        name: "clean_task",
        input: {
          requiredTools: ["tool1", 123, null, "   ", "tool2"],
        },
      });
      expect(req.requiredTools).toEqual(["tool1", "tool2"]);
    });

    it("handles primitive string input safely", () => {
      const req = extractTaskRequirements({
        name: "simple_task",
        input: "some raw string input",
      });
      expect(req).toEqual({
        taskType: "simple_task",
        requiredTools: [],
      });
    });
  });

  describe("taskRequirementsSchema", () => {
    it("validates a compliant task requirements payload", () => {
      const valid = {
        taskType: "llm_generation",
        requiredTools: ["openai_completion", "token_counter"],
      };
      const result = taskRequirementsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("defaults requiredTools to empty array", () => {
      const parsed = taskRequirementsSchema.parse({
        taskType: "batch_indexing",
      });
      expect(parsed.requiredTools).toEqual([]);
    });

    it("rejects empty taskType", () => {
      const result = taskRequirementsSchema.safeParse({
        taskType: "",
        requiredTools: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("workerSelectionFailureReasonSchema", () => {
    it("validates all failure reason enum values", () => {
      const reasons = [
        WorkerSelectionFailureReasonEnum.NO_REGISTERED_WORKERS,
        WorkerSelectionFailureReasonEnum.NO_HEALTHY_WORKERS,
        WorkerSelectionFailureReasonEnum.NO_CAPABLE_WORKERS,
        WorkerSelectionFailureReasonEnum.CAPACITY_EXHAUSTED,
      ];
      for (const reason of reasons) {
        expect(workerSelectionFailureReasonSchema.parse(reason)).toBe(reason);
      }
    });

    it("rejects invalid failure reason", () => {
      expect(
        workerSelectionFailureReasonSchema.safeParse("WORKER_TIMEOUT").success,
      ).toBe(false);
    });
  });

  describe("workerSelectionResultSchema", () => {
    const mockDescriptor: WorkerDescriptor = {
      workerId: workerId("worker-test-1"),
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: {
        taskTypes: ["*"],
        tools: ["bash"],
        maxConcurrency: 4,
      },
      activeTaskCount: 1,
      maxConcurrentTasks: 4,
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };

    it("parses successful selection", () => {
      const parsed = workerSelectionResultSchema.parse({
        selectedWorker: mockDescriptor,
        evaluatedWorkerCount: 5,
        eligibleWorkerCount: 2,
      });
      expect(parsed.selectedWorker?.workerId).toBe("worker-test-1");
      expect(parsed.eligibleWorkerCount).toBe(2);
    });

    it("parses unselected result with failureReason", () => {
      const parsed = workerSelectionResultSchema.parse({
        failureReason: "CAPACITY_EXHAUSTED",
        evaluatedWorkerCount: 3,
        eligibleWorkerCount: 0,
      });
      expect(parsed.selectedWorker).toBeUndefined();
      expect(parsed.failureReason).toBe("CAPACITY_EXHAUSTED");
    });
  });

  describe("dispatchErrorCodeSchema & createDispatchError", () => {
    it("validates all dispatch error codes", () => {
      const codes = [
        "NO_ELIGIBLE_WORKER",
        "ASSIGNMENT_BUILD_FAILED",
        "TOPIC_PROVISION_FAILED",
        "DISPATCH_PUBLISH_FAILED",
        "INVALID_DISPATCH_REQUEST",
      ];
      for (const code of codes) {
        expect(dispatchErrorCodeSchema.parse(code)).toBe(code);
      }
    });

    it("creates DispatchError with structured fields", () => {
      const error: DispatchError = createDispatchError(
        "TOPIC_PROVISION_FAILED",
        "Failed to provision topic for worker",
        new Error("Kafka admin timeout"),
      );
      expect(error.code).toBe("TOPIC_PROVISION_FAILED");
      expect(error.message).toContain("Failed to provision");
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  describe("dispatchResultSchema", () => {
    it("validates ASSIGNED dispatch result", () => {
      const validResult: DispatchResult = {
        status: "ASSIGNED",
        taskId: taskId("task-101"),
        runId: runId("run-202"),
        assignmentId: assignmentId("asgn-303"),
        workerId: workerId("worker-404"),
        targetTopic: "aegis.tasks.assign.worker-404",
      };
      const parsed = dispatchResultSchema.parse(validResult);
      expect(parsed.status).toBe("ASSIGNED");
      expect(parsed.targetTopic).toBe("aegis.tasks.assign.worker-404");
    });

    it("validates NO_ELIGIBLE_WORKER dispatch result", () => {
      const noWorkerResult: DispatchResult = {
        status: "NO_ELIGIBLE_WORKER",
        taskId: taskId("task-102"),
        runId: runId("run-203"),
        reason: "NO_HEALTHY_WORKERS",
      };
      const parsed = dispatchResultSchema.parse(noWorkerResult);
      expect(parsed.status).toBe("NO_ELIGIBLE_WORKER");
      expect(parsed.reason).toBe("NO_HEALTHY_WORKERS");
    });

    it("validates DISPATCH_FAILED dispatch result", () => {
      const failedResult: DispatchResult = {
        status: "DISPATCH_FAILED",
        taskId: taskId("task-103"),
        runId: runId("run-204"),
        error: {
          code: "DISPATCH_PUBLISH_FAILED",
          message: "Broker disconnect",
        },
      };
      const parsed = dispatchResultSchema.parse(failedResult);
      expect(parsed.status).toBe("DISPATCH_FAILED");
      expect(parsed.error?.code).toBe("DISPATCH_PUBLISH_FAILED");
    });
  });

  describe("Interface Type Compliance", () => {
    it("verifies IWorkerSelector interface contract", () => {
      const selector: IWorkerSelector = {
        selectWorker: (_task, candidates) => ({
          selectedWorker: candidates[0],
          evaluatedWorkerCount: candidates.length,
          eligibleWorkerCount: candidates.length > 0 ? 1 : 0,
        }),
      };
      expect(typeof selector.selectWorker).toBe("function");
    });

    it("verifies ITopicProvisioner interface contract", () => {
      const provisioner: ITopicProvisioner = {
        ensureTopic: (_topic) => Promise.resolve({ ok: true, value: true }),
      };
      expect(typeof provisioner.ensureTopic).toBe("function");
    });

    it("verifies ITaskAssignmentPublisher interface contract", () => {
      const publisher: ITaskAssignmentPublisher = {
        publish: (_topic, envelope) => Promise.resolve({ ok: true, value: envelope }),
      };
      expect(typeof publisher.publish).toBe("function");
    });

    it("verifies ITaskDispatcher interface contract", () => {
      const dispatcher: ITaskDispatcher = {
        dispatch: (task) =>
          Promise.resolve({
            status: "ASSIGNED",
            taskId: task.id,
            runId: runId("run-1"),
            assignmentId: assignmentId("asgn-1"),
            workerId: workerId("worker-1"),
            targetTopic: "aegis.tasks.assign.worker-1",
          }),
      };
      expect(typeof dispatcher.dispatch).toBe("function");
    });
  });
});
