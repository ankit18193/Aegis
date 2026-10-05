import type { Task, WorkerDescriptor } from "@aegis/contracts";
import { taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { DeterministicWorkerSelector } from "../workerSelector.js";

describe("DeterministicWorkerSelector (Phase 11E — Commit 2)", () => {
  const selector = new DeterministicWorkerSelector();

  function createMockTask(overrides?: Partial<Task>): Task {
    return {
      id: taskId("task-test-1"),
      name: "data_processor",
      status: "pending",
      description: "Sample processing task",
      attemptCount: 0,
      version: 1,
      dependencies: [],
      ...overrides,
    };
  }

  function createMockWorker(
    id: string,
    overrides?: Partial<WorkerDescriptor>,
  ): WorkerDescriptor {
    return {
      workerId: workerId(id),
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: {
        taskTypes: ["*"],
        tools: ["python", "bash"],
        maxConcurrency: 5,
      },
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("Failure Diagnostics", () => {
    it("returns NO_REGISTERED_WORKERS when candidate list is empty", () => {
      const task = createMockTask();
      const result = selector.selectWorker(task, []);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("NO_REGISTERED_WORKERS");
      expect(result.evaluatedWorkerCount).toBe(0);
      expect(result.eligibleWorkerCount).toBe(0);
    });

    it("returns NO_HEALTHY_WORKERS when all workers are STALE or OFFLINE", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-stale", { presenceState: "STALE" }),
        createMockWorker("w-offline", { presenceState: "OFFLINE" }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("NO_HEALTHY_WORKERS");
      expect(result.evaluatedWorkerCount).toBe(2);
      expect(result.eligibleWorkerCount).toBe(0);
    });

    it("returns NO_CAPABLE_WORKERS when no worker matches the task type", () => {
      const task = createMockTask({ name: "unsupported_task" });
      const candidates = [
        createMockWorker("w-1", {
          capabilities: { taskTypes: ["etl_pipeline"], tools: [], maxConcurrency: 4 },
        }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("NO_CAPABLE_WORKERS");
      expect(result.evaluatedWorkerCount).toBe(1);
    });

    it("returns NO_CAPABLE_WORKERS when worker lacks required tools", () => {
      const task = createMockTask({
        name: "python_script",
        input: { requiredTools: ["web_search", "browser"] },
      });
      const candidates = [
        createMockWorker("w-1", {
          capabilities: {
            taskTypes: ["python_script"],
            tools: ["web_search"], // missing "browser"
            maxConcurrency: 4,
          },
        }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("NO_CAPABLE_WORKERS");
    });

    it("returns CAPACITY_EXHAUSTED when all capable workers are at max concurrency", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-busy-1", {
          activeTaskCount: 4,
          maxConcurrentTasks: 4,
        }),
        createMockWorker("w-busy-2", {
          activeTaskCount: 2,
          maxConcurrentTasks: 2,
        }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("CAPACITY_EXHAUSTED");
      expect(result.evaluatedWorkerCount).toBe(2);
      expect(result.eligibleWorkerCount).toBe(0);
    });
  });

  describe("Lifecycle State Filtering", () => {
    it("excludes workers in starting, draining, stopped, or failed states", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-starting", { lifecycleState: "starting" }),
        createMockWorker("w-draining", { lifecycleState: "draining" }),
        createMockWorker("w-stopped", { lifecycleState: "stopped" }),
        createMockWorker("w-failed", { lifecycleState: "failed" }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker).toBeUndefined();
      expect(result.failureReason).toBe("NO_CAPABLE_WORKERS");
    });

    it("includes workers in 'ready' or 'busy' states if capacity remains", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-busy", {
          lifecycleState: "busy",
          activeTaskCount: 1,
          maxConcurrentTasks: 4,
        }),
      ];

      const result = selector.selectWorker(task, candidates);

      expect(result.selectedWorker?.workerId).toBe("w-busy");
      expect(result.eligibleWorkerCount).toBe(1);
    });
  });

  describe("Capability Matching", () => {
    it("matches task type with wildcard '*'", () => {
      const task = createMockTask({ name: "any_specialized_task" });
      const candidates = [
        createMockWorker("w-wildcard", {
          capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 2 },
        }),
      ];

      const result = selector.selectWorker(task, candidates);
      expect(result.selectedWorker?.workerId).toBe("w-wildcard");
    });

    it("matches task type case-insensitively", () => {
      const task = createMockTask({ name: "Data_Mining" });
      const candidates = [
        createMockWorker("w-1", {
          capabilities: { taskTypes: ["data_mining"], tools: [], maxConcurrency: 2 },
        }),
      ];

      const result = selector.selectWorker(task, candidates);
      expect(result.selectedWorker?.workerId).toBe("w-1");
    });

    it("matches when all required tools are present in worker capabilities", () => {
      const task = createMockTask({
        name: "analysis",
        input: { requiredTools: ["llm", "calculator"] },
      });
      const candidates = [
        createMockWorker("w-subset", {
          capabilities: { taskTypes: ["analysis"], tools: ["llm"], maxConcurrency: 2 },
        }),
        createMockWorker("w-superset", {
          capabilities: {
            taskTypes: ["analysis"],
            tools: ["llm", "calculator", "browser"],
            maxConcurrency: 2,
          },
        }),
      ];

      const result = selector.selectWorker(task, candidates);
      expect(result.selectedWorker?.workerId).toBe("w-superset");
    });
  });

  describe("Deterministic Selection & Load Balancing (Lock 7)", () => {
    it("selects worker with least activeTaskCount", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-heavy", { activeTaskCount: 3, maxConcurrentTasks: 5 }),
        createMockWorker("w-light", { activeTaskCount: 1, maxConcurrentTasks: 5 }),
        createMockWorker("w-medium", { activeTaskCount: 2, maxConcurrentTasks: 5 }),
      ];

      const result = selector.selectWorker(task, candidates);
      expect(result.selectedWorker?.workerId).toBe("w-light");
      expect(result.eligibleWorkerCount).toBe(3);
    });

    it("breaks equal-load ties deterministically via lexicographical workerId", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("worker-charlie", { activeTaskCount: 1, maxConcurrentTasks: 5 }),
        createMockWorker("worker-alpha", { activeTaskCount: 1, maxConcurrentTasks: 5 }),
        createMockWorker("worker-bravo", { activeTaskCount: 1, maxConcurrentTasks: 5 }),
      ];

      const result = selector.selectWorker(task, candidates);
      expect(result.selectedWorker?.workerId).toBe("worker-alpha");
    });

    it("guarantees 100% deterministic repeatability over repeated calls", () => {
      const task = createMockTask();
      const candidates = [
        createMockWorker("w-z", { activeTaskCount: 2, maxConcurrentTasks: 10 }),
        createMockWorker("w-m", { activeTaskCount: 1, maxConcurrentTasks: 10 }),
        createMockWorker("w-a", { activeTaskCount: 1, maxConcurrentTasks: 10 }),
      ];

      for (let i = 0; i < 50; i++) {
        const result = selector.selectWorker(task, candidates);
        expect(result.selectedWorker?.workerId).toBe("w-a");
      }
    });
  });
});
