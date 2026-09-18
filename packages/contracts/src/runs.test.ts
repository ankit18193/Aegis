import { describe, expect, it } from "vitest";

import {
  isValidRunTransition,
  isValidTaskTransition,
  runResultSchema,
  runSchema,
  runStatusSchema,
  runSummarySchema,
  taskSchema,
  taskStatusSchema,
  VALID_RUN_TRANSITIONS,
  VALID_TASK_TRANSITIONS,
  workflowSchema,
} from "./runs.js";

describe("Runs & Tasks Contract Schemas", () => {
  describe("runStatusSchema & taskStatusSchema", () => {
    it("validates all canonical run status values", () => {
      const validStatuses = ["pending", "running", "completed", "failed", "cancelled"];
      for (const status of validStatuses) {
        expect(runStatusSchema.parse(status)).toBe(status);
      }
      expect(() => runStatusSchema.parse("invalid_status")).toThrow();
    });

    it("validates all canonical task status values", () => {
      const validStatuses = [
        "pending",
        "queued",
        "running",
        "completed",
        "failed",
        "retrying",
        "cancelled",
      ];
      for (const status of validStatuses) {
        expect(taskStatusSchema.parse(status)).toBe(status);
      }
      expect(() => taskStatusSchema.parse("unknown")).toThrow();
    });
  });

  describe("Lifecycle State Transitions", () => {
    it("allows legal run transitions", () => {
      expect(isValidRunTransition("pending", "running")).toBe(true);
      expect(isValidRunTransition("pending", "cancelled")).toBe(true);
      expect(isValidRunTransition("running", "completed")).toBe(true);
      expect(isValidRunTransition("running", "failed")).toBe(true);
      expect(isValidRunTransition("running", "cancelled")).toBe(true);
    });

    it("rejects illegal run transitions", () => {
      expect(isValidRunTransition("pending", "completed")).toBe(false);
      expect(isValidRunTransition("running", "pending")).toBe(false);
      expect(isValidRunTransition("completed", "running")).toBe(false);
      expect(isValidRunTransition("failed", "running")).toBe(false);
      expect(isValidRunTransition("cancelled", "pending")).toBe(false);
    });

    it("enforces terminal states for runs have zero outgoing transitions", () => {
      expect(VALID_RUN_TRANSITIONS.completed).toHaveLength(0);
      expect(VALID_RUN_TRANSITIONS.failed).toHaveLength(0);
      expect(VALID_RUN_TRANSITIONS.cancelled).toHaveLength(0);
    });

    it("allows legal task transitions including retries", () => {
      expect(isValidTaskTransition("pending", "queued")).toBe(true);
      expect(isValidTaskTransition("queued", "running")).toBe(true);
      expect(isValidTaskTransition("running", "retrying")).toBe(true);
      expect(isValidTaskTransition("retrying", "queued")).toBe(true);
      expect(isValidTaskTransition("retrying", "running")).toBe(true);
      expect(isValidTaskTransition("retrying", "failed")).toBe(true);
      expect(isValidTaskTransition("running", "completed")).toBe(true);
    });

    it("rejects illegal task transitions", () => {
      expect(isValidTaskTransition("completed", "running")).toBe(false);
      expect(isValidTaskTransition("failed", "queued")).toBe(false);
      expect(isValidTaskTransition("cancelled", "pending")).toBe(false);
    });

    it("enforces terminal states for tasks have zero outgoing transitions", () => {
      expect(VALID_TASK_TRANSITIONS.completed).toHaveLength(0);
      expect(VALID_TASK_TRANSITIONS.failed).toHaveLength(0);
      expect(VALID_TASK_TRANSITIONS.cancelled).toHaveLength(0);
    });
  });

  describe("taskSchema", () => {
    it("parses valid task definition", () => {
      const task = taskSchema.parse({
        id: "task-001",
        name: "Analyze repository",
        status: "pending",
        description: "Scans files",
        attemptCount: 0,
      });

      expect(task.id).toBe("task-001");
      expect(task.name).toBe("Analyze repository");
      expect(task.status).toBe("pending");
      expect(task.attemptCount).toBe(0);
    });

    it("rejects task with negative attempt count", () => {
      expect(() =>
        taskSchema.parse({
          id: "task-001",
          name: "Invalid task",
          status: "pending",
          description: "",
          attemptCount: -1,
        }),
      ).toThrow();
    });

    it("rejects task with empty name", () => {
      expect(() =>
        taskSchema.parse({
          id: "task-001",
          name: "",
          status: "pending",
          description: "",
        }),
      ).toThrow();
    });
  });

  describe("workflowSchema", () => {
    it("parses workflow with tasks", () => {
      const wf = workflowSchema.parse({
        id: "wf-100",
        name: "Optimization Workflow",
        tasks: [
          {
            id: "t-1",
            name: "Step 1",
            status: "completed",
            description: "",
          },
        ],
      });

      expect(wf.id).toBe("wf-100");
      expect(wf.tasks).toHaveLength(1);
    });
  });

  describe("runResultSchema", () => {
    it("parses valid run result with metrics and artifacts", () => {
      const res = runResultSchema.parse({
        summary: "Analysis complete",
        reportMarkdown: "# Findings\nNone.",
        metrics: {
          durationMs: 4200,
          tasksTotal: 3,
          tasksCompleted: 3,
          toolInvocations: 12,
        },
        artifacts: [
          {
            name: "report.pdf",
            type: "application/pdf",
            path: "/tmp/report.pdf",
            sizeBytes: 1024,
          },
        ],
      });

      expect(res.summary).toBe("Analysis complete");
      expect(res.metrics?.toolInvocations).toBe(12);
      expect(res.artifacts?.[0]?.name).toBe("report.pdf");
    });
  });

  describe("runSchema", () => {
    it("parses full valid execution run", () => {
      const run = runSchema.parse({
        id: "run-abc",
        goal: "Deploy staging environment",
        status: "running",
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:05:00.000Z",
        progress: 50,
        workflow: {
          id: "wf-1",
          name: "Deploy",
          tasks: [],
        },
        tasks: [
          {
            id: "t-1",
            name: "Provision VMs",
            status: "completed",
            description: "Terraform apply",
          },
        ],
      });

      expect(run.id).toBe("run-abc");
      expect(run.progress).toBe(50);
      expect(run.tasks).toHaveLength(1);
    });

    it("rejects run with progress outside 0-100 bounds", () => {
      expect(() =>
        runSchema.parse({
          id: "run-abc",
          goal: "Deploy staging environment",
          status: "running",
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:05:00.000Z",
          progress: 105,
          workflow: { id: "wf-1", name: "Deploy", tasks: [] },
          tasks: [],
        }),
      ).toThrow();
    });
  });

  describe("runSummarySchema", () => {
    it("parses lightweight run summary projection", () => {
      const summary = runSummarySchema.parse({
        id: "run-001",
        goal: "Run test suite",
        status: "completed",
        createdAt: "2026-09-18T09:00:00.000Z",
        updatedAt: "2026-09-18T09:05:00.000Z",
        progress: 100,
        totalTasks: 5,
        completedTasks: 5,
      });

      expect(summary.id).toBe("run-001");
      expect(summary.totalTasks).toBe(5);
      expect(summary.completedTasks).toBe(5);
    });
  });
});
