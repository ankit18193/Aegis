/**
 * Integration test suite for PostgresRunRepository.
 * Tests real PostgreSQL persistence, relational cascading, transactional
 * task synchronization (Lock 2), cursor pagination, and audit event queries
 * against the real Docker PostgreSQL instance.
 */

import type { Run, RunEvent } from "@aegis/contracts";
import { eventId, runId, taskId, workflowId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";

import { PostgresRunRepository } from "./postgresRunRepository.js";

describe("PostgresRunRepository Integration Tests (Real PostgreSQL)", () => {
  let ctx: DatabaseContext;
  let repository: PostgresRunRepository;

  beforeAll(async () => {
    ctx = createDatabaseContext({
      url: "postgresql://postgres:postgres@localhost:5433/aegis",
      poolMin: 1,
      poolMax: 3,
    });
    // Ensure migrations are up to date
    await runMigrations(ctx.db);
    repository = new PostgresRunRepository(ctx);
  }, 30000);

  beforeEach(async () => {
    // Reset to canonical seed data before each test
    await repository.resetToDefaults();
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe("resetToDefaults & seed initialization", () => {
    it("populates canonical seed runs and events", async () => {
      const result = await repository.findAll();
      expect(result.totalCount).toBe(4);
      expect(result.items).toHaveLength(4);

      const run1 = await repository.findById(runId("run-001"));
      expect(run1).not.toBeNull();
      expect(run1?.goal).toContain("Analyze repository performance");
      expect(run1?.tasks).toHaveLength(5);
      expect(run1?.workflow.tasks).toHaveLength(5);

      const events = await repository.findEvents(runId("run-001"));
      expect(events.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("findById", () => {
    it("returns null for a non-existent run ID", async () => {
      const run = await repository.findById(runId("non-existent-id"));
      expect(run).toBeNull();
    });

    it("retrieves complete run with workflow, tasks, and result payload", async () => {
      const run2 = await repository.findById(runId("run-002"));
      expect(run2).not.toBeNull();
      expect(run2?.id).toBe(runId("run-002"));
      expect(run2?.status).toBe("completed");
      expect(run2?.progress).toBe(100);
      expect(run2?.workflow.name).toBe("Zero-Trust Worker Authentication Pipeline");
      expect(run2?.tasks).toHaveLength(3);
      expect(run2?.tasks[0]?.status).toBe("completed");
      expect(run2?.result).toBeDefined();
      expect(run2?.result?.summary).toContain("Zero-trust edge worker authentication");
      expect(run2?.result?.metrics?.tasksTotal).toBe(3);
      expect(run2?.result?.artifacts).toHaveLength(1);
    });
  });

  describe("findAll", () => {
    it("orders runs by createdAt descending and computes task metrics", async () => {
      const result = await repository.findAll();
      expect(result.items).toHaveLength(4);

      // Verify task counts aggregation
      const summary1 = result.items.find((r) => r.id === runId("run-001"));
      expect(summary1).toBeDefined();
      expect(summary1?.totalTasks).toBe(5);
      expect(summary1?.completedTasks).toBe(2);

      const summary2 = result.items.find((r) => r.id === runId("run-002"));
      expect(summary2).toBeDefined();
      expect(summary2?.totalTasks).toBe(3);
      expect(summary2?.completedTasks).toBe(3);
    });

    it("filters runs by status", async () => {
      const runningResult = await repository.findAll({ status: "running" });
      expect(runningResult.items).toHaveLength(1);
      expect(runningResult.items[0]?.id).toBe(runId("run-001"));

      const completedResult = await repository.findAll({ status: "completed" });
      expect(completedResult.items).toHaveLength(1);
      expect(completedResult.items[0]?.id).toBe(runId("run-002"));

      const failedResult = await repository.findAll({ status: "failed" });
      expect(failedResult.items).toHaveLength(1);
      expect(failedResult.items[0]?.id).toBe(runId("run-003"));
    });

    it("filters runs by search query substring on goal", async () => {
      const result = await repository.findAll({ query: "replica failover" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(runId("run-003"));
    });

    it("paginates runs with limit and cursor", async () => {
      const page1 = await repository.findAll({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.totalCount).toBe(4);

      const cursor = page1.items[1]?.id;
      expect(cursor).toBeDefined();

      const page2 = await repository.findAll({ limit: 2, cursor });
      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(false);

      // Verify no duplicate IDs between pages
      const page1Ids = page1.items.map((r) => r.id);
      const page2Ids = page2.items.map((r) => r.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });
  });

  describe("save & transactional task synchronization (Lock 2)", () => {
    it("persists a newly created execution run with tasks", async () => {
      const newRunId = runId("run-test-create-01");
      const now = new Date().toISOString();

      const newRun: Run = {
        id: newRunId,
        goal: "Test database transaction persistence",
        status: "pending",
        progress: 0,
        createdAt: now,
        updatedAt: now,
        workflow: {
          id: workflowId("wf-test-01"),
          name: "Test Persistence Workflow",
          tasks: [],
        },
        tasks: [
          {
            id: taskId("task-test-01"),
            name: "Initial Step",
            description: "Step one description",
            status: "pending",
            attemptCount: 0,
          },
          {
            id: taskId("task-test-02"),
            name: "Second Step",
            description: "Step two description",
            status: "pending",
            attemptCount: 0,
            dependencies: [taskId("task-test-01")],
          },
        ],
      };
      newRun.workflow.tasks = structuredClone(newRun.tasks);

      await repository.save(newRun);

      const fetched = await repository.findById(newRunId);
      expect(fetched).not.toBeNull();
      expect(fetched?.goal).toBe("Test database transaction persistence");
      expect(fetched?.tasks).toHaveLength(2);
      expect(fetched?.tasks[1]?.dependencies).toEqual([taskId("task-test-01")]);
    });

    it("synchronizes existing tasks in place without destroying or reinserting them", async () => {
      const run = await repository.findById(runId("run-001"));
      expect(run).not.toBeNull();
      if (!run) return;

      // Mutate task 103 to completed
      const task103 = run.tasks.find((t) => t.id === taskId("task-103"));
      expect(task103).toBeDefined();
      if (task103) {
        task103.status = "completed";
        task103.output = "Profiling completed: latency under 12ms.";
        task103.completedAt = new Date().toISOString();
      }

      // Add a new task
      run.tasks.push({
        id: taskId("task-106-new"),
        name: "Supplemental Benchmark",
        description: "Verify sustained throughput under 500 connections.",
        status: "queued",
        attemptCount: 0,
      });

      // Remove task-105
      run.tasks = run.tasks.filter((t) => t.id !== taskId("task-105"));
      run.workflow.tasks = structuredClone(run.tasks);
      run.progress = 80;
      run.updatedAt = new Date().toISOString();

      await repository.save(run);

      const updated = await repository.findById(runId("run-001"));
      expect(updated).not.toBeNull();
      expect(updated?.progress).toBe(80);
      expect(updated?.tasks).toHaveLength(5); // 5 - 1 + 1 = 5

      const reloadedTask103 = updated?.tasks.find((t) => t.id === taskId("task-103"));
      expect(reloadedTask103?.status).toBe("completed");
      expect(reloadedTask103?.output).toBe("Profiling completed: latency under 12ms.");

      const newTask = updated?.tasks.find((t) => t.id === taskId("task-106-new"));
      expect(newTask).toBeDefined();
      expect(newTask?.name).toBe("Supplemental Benchmark");

      const removedTask = updated?.tasks.find((t) => t.id === taskId("task-105"));
      expect(removedTask).toBeUndefined();
    });
  });

  describe("findEvents & saveEvent", () => {
    it("returns events in ascending chronological order", async () => {
      const events = await repository.findEvents(runId("run-001"));
      expect(events.length).toBeGreaterThanOrEqual(10);

      for (let i = 0; i < events.length - 1; i++) {
        const curr = new Date(events[i]?.timestamp ?? "").getTime();
        const next = new Date(events[i + 1]?.timestamp ?? "").getTime();
        expect(curr).toBeLessThanOrEqual(next);
      }
    });

    it("filters events by severity", async () => {
      const successEvents = await repository.findEvents(runId("run-001"), {
        severity: "success",
      });
      expect(successEvents.length).toBeGreaterThan(0);
      for (const ev of successEvents) {
        expect(ev.severity).toBe("success");
      }
    });

    it("filters events by event type", async () => {
      const scheduledEvents = await repository.findEvents(runId("run-001"), {
        type: "task_scheduled",
      });
      expect(scheduledEvents.length).toBeGreaterThan(0);
      for (const ev of scheduledEvents) {
        expect(ev.type).toBe("task_scheduled");
      }
    });

    it("paginates events with limit and cursor", async () => {
      const page1 = await repository.findEvents(runId("run-001"), { limit: 3 });
      expect(page1).toHaveLength(3);

      const cursor = page1[2]?.id;
      expect(cursor).toBeDefined();

      const page2 = await repository.findEvents(runId("run-001"), { limit: 3, cursor });
      expect(page2).toHaveLength(3);

      const page1Ids = page1.map((e) => e.id);
      const page2Ids = page2.map((e) => e.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it("saves and retrieves a new audit event with metadata", async () => {
      const newEv: RunEvent = {
        id: eventId("ev-custom-test-01"),
        runId: runId("run-001"),
        type: "tool_invoked",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: "Tool invoked: query_profiler",
        taskId: taskId("task-103"),
        taskName: "Query Execution Profiling",
        metadata: {
          executionTimeMs: 450,
          queryCount: 12,
        },
      };

      await repository.saveEvent(newEv);

      const events = await repository.findEvents(runId("run-001"));
      const found = events.find((e) => e.id === eventId("ev-custom-test-01"));
      expect(found).toBeDefined();
      expect(found?.message).toBe("Tool invoked: query_profiler");
      expect(found?.metadata).toEqual({
        executionTimeMs: 450,
        queryCount: 12,
      });
    });

    it("atomically persists run updates and new events in a single transaction", async () => {
      const run = await repository.findById(runId("run-001"));
      expect(run).not.toBeNull();
      if (!run) return;

      run.status = "running";
      run.progress = 65;

      const atomicEvent: RunEvent = {
        id: eventId("ev-atomic-test-01"),
        runId: run.id,
        type: "tool_invoked",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: "Action 'calculate' executed successfully",
        metadata: {
          actionName: "calculate",
          result: 42,
        },
      };

      await repository.save(run, [atomicEvent]);

      const reloadedRun = await repository.findById(run.id);
      expect(reloadedRun?.progress).toBe(65);

      const events = await repository.findEvents(run.id);
      const foundEvent = events.find((e) => e.id === eventId("ev-atomic-test-01"));
      expect(foundEvent).toBeDefined();
      expect(foundEvent?.type).toBe("tool_invoked");
      expect(foundEvent?.metadata).toEqual({
        actionName: "calculate",
        result: 42,
      });
    });
  });
});

