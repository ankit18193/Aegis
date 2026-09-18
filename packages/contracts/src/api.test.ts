import { describe, expect, it } from "vitest";

import {
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  createRunRequestSchema,
  createRunResponseSchema,
  getRunEventsQuerySchema,
  getRunEventsResponseSchema,
  getRunResponseSchema,
  listRunsQuerySchema,
  listRunsResponseSchema,
} from "./api.js";

describe("API Request and Response Contracts", () => {
  describe("createRunRequestSchema", () => {
    it("accepts valid goal input and trims leading/trailing whitespace", () => {
      const parsed = createRunRequestSchema.parse({
        goal: "  Benchmark server cluster latency  ",
      });
      expect(parsed.goal).toBe("Benchmark server cluster latency");
    });

    it("rejects goals that are too short (< 3 characters)", () => {
      expect(() => createRunRequestSchema.parse({ goal: "ab" })).toThrow();
      expect(() => createRunRequestSchema.parse({ goal: "  a  " })).toThrow();
    });

    it("rejects goals that exceed 1000 characters", () => {
      expect(() => createRunRequestSchema.parse({ goal: "x".repeat(1001) })).toThrow();
    });

    it("accepts optional workflowTemplateId and parameters", () => {
      const parsed = createRunRequestSchema.parse({
        goal: "Execute deployment pipeline",
        workflowTemplateId: "wf-template-01",
        parameters: { dryRun: true, replicas: 3 },
      });
      expect(parsed.workflowTemplateId).toBe("wf-template-01");
      expect(parsed.parameters).toEqual({ dryRun: true, replicas: 3 });
    });
  });

  describe("listRunsQuerySchema", () => {
    it("parses valid query parameters with default limit", () => {
      const parsed = listRunsQuerySchema.parse({});
      expect(parsed.limit).toBe(20);
    });

    it("accepts custom limit and status filter", () => {
      const parsed = listRunsQuerySchema.parse({
        status: "running",
        limit: 50,
        query: "database",
      });
      expect(parsed.status).toBe("running");
      expect(parsed.limit).toBe(50);
      expect(parsed.query).toBe("database");
    });

    it("rejects limit greater than 100", () => {
      expect(() => listRunsQuerySchema.parse({ limit: 150 })).toThrow();
    });

    it("rejects negative limit", () => {
      expect(() => listRunsQuerySchema.parse({ limit: -5 })).toThrow();
    });

    it("coerces stringified numeric limit from HTTP query parameters", () => {
      const parsed = listRunsQuerySchema.parse({ limit: "25" });
      expect(parsed.limit).toBe(25);
    });
  });

  describe("cancelRunRequestSchema", () => {
    it("accepts empty request or optional reason", () => {
      expect(cancelRunRequestSchema.parse({})).toEqual({});
      const parsed = cancelRunRequestSchema.parse({ reason: "User requested abort" });
      expect(parsed.reason).toBe("User requested abort");
    });

    it("rejects reason exceeding 500 characters", () => {
      expect(() => cancelRunRequestSchema.parse({ reason: "a".repeat(501) })).toThrow();
    });
  });

  describe("getRunEventsQuerySchema", () => {
    it("accepts optional severity, type, and pagination filters", () => {
      const parsed = getRunEventsQuerySchema.parse({
        severity: "error",
        type: "task_failed",
        limit: 10,
        cursor: "cursor-123",
      });
      expect(parsed.severity).toBe("error");
      expect(parsed.type).toBe("task_failed");
      expect(parsed.limit).toBe(10);
      expect(parsed.cursor).toBe("cursor-123");
    });

    it("rejects limit exceeding 200", () => {
      expect(() => getRunEventsQuerySchema.parse({ limit: 250 })).toThrow();
    });

    it("coerces stringified numeric limit from HTTP query parameters", () => {
      const parsed = getRunEventsQuerySchema.parse({ limit: "75" });
      expect(parsed.limit).toBe(75);
    });
  });

  describe("Response Envelopes", () => {
    const sampleRun = {
      id: "run-999",
      goal: "Analyze code",
      status: "completed" as const,
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:05:00.000Z",
      progress: 100,
      workflow: { id: "wf-1", name: "Analysis", tasks: [] },
      tasks: [],
    };

    it("parses createRunResponseSchema", () => {
      const res = createRunResponseSchema.parse({ run: sampleRun });
      expect(res.run.id).toBe("run-999");
    });

    it("parses getRunResponseSchema", () => {
      const res = getRunResponseSchema.parse({ run: sampleRun });
      expect(res.run.status).toBe("completed");
    });

    it("parses cancelRunResponseSchema", () => {
      const res = cancelRunResponseSchema.parse({ run: sampleRun });
      expect(res.run.progress).toBe(100);
    });

    it("parses listRunsResponseSchema with pagination", () => {
      const res = listRunsResponseSchema.parse({
        items: [
          {
            id: "run-999",
            goal: "Analyze code",
            status: "completed",
            createdAt: "2026-09-18T10:00:00.000Z",
            updatedAt: "2026-09-18T10:05:00.000Z",
            progress: 100,
            totalTasks: 2,
            completedTasks: 2,
          },
        ],
        nextCursor: "next-token-abc",
        totalCount: 1,
      });
      expect(res.items).toHaveLength(1);
      expect(res.nextCursor).toBe("next-token-abc");
    });

    it("parses getRunEventsResponseSchema", () => {
      const res = getRunEventsResponseSchema.parse({
        events: [
          {
            id: "evt-01",
            runId: "run-999",
            type: "run_created",
            severity: "info",
            timestamp: "2026-09-18T10:00:00.000Z",
            message: "Run created",
          },
        ],
      });
      expect(res.events).toHaveLength(1);
      expect(res.events[0]?.type).toBe("run_created");
    });
  });
});
