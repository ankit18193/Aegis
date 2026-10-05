import type {
  ITaskExecutor,
  ITaskLeaseClient,
  ITaskResultPublisher,
  TaskAssignment,
  TaskLease,
  TaskLeaseRenewRequest,
} from "@aegis/contracts";
import { LeaseExpiredError, StaleLeaseError } from "@aegis/contracts";
import { assignmentId, leaseId, runId, taskId, workerId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskExecutionService } from "../executionService.js";
import { WorkerTaskLeaseManager } from "../leaseManager.js";

describe("WorkerTaskLeaseManager (Phase 12B — Commit 3)", () => {
  const sampleTaskId = taskId("task-worker-101");
  const sampleWorkerId = workerId("worker-alpha");
  const sampleLeaseId = leaseId("lease-init-101");

  function createInitialLease(durationMs = 30000, version = 1): TaskLease {
    const now = Date.now();
    return {
      leaseId: sampleLeaseId,
      taskId: sampleTaskId,
      workerId: sampleWorkerId,
      acquiredAt: new Date(now).toISOString(),
      leaseUntil: new Date(now + durationMs).toISOString(),
      version,
    };
  }

  describe("Lifecycle and Periodic Renewal", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("initializes with active lease state", () => {
      const initialLease = createInitialLease(30000, 1);
      const mockAcquire = vi.fn();
      const mockRenew = vi.fn();
      const mockRelease = vi.fn();
      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const manager = new WorkerTaskLeaseManager({
        leaseClient: mockClient,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        initialLease,
      });

      expect(manager.lease).toEqual(initialLease);
      expect(manager.isLost).toBe(false);
      expect(manager.isLeaseActive()).toBe(true);
      expect(manager.active).toBe(false);
    });

    it("automatically triggers periodic lease renewals via background timer", async () => {
      const initialLease = createInitialLease(30000, 1);
      let currentVersion = 1;

      const mockAcquire = vi.fn();
      const mockRenew = vi.fn().mockImplementation((req: TaskLeaseRenewRequest) => {
        currentVersion = req.expectedVersion + 1;
        return Promise.resolve({
          ok: true,
          value: {
            leaseId: req.leaseId,
            taskId: req.taskId,
            workerId: req.workerId,
            acquiredAt: initialLease.acquiredAt,
            leaseUntil: new Date(Date.now() + req.leaseDurationMs).toISOString(),
            version: currentVersion,
          },
        });
      });
      const mockRelease = vi.fn().mockResolvedValue({ ok: true, value: undefined });

      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const manager = new WorkerTaskLeaseManager({
        leaseClient: mockClient,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        initialLease,
        config: { renewalIntervalMs: 1000, leaseDurationMs: 5000 },
      });

      manager.start();
      expect(manager.active).toBe(true);

      // Advance by 1 interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockRenew).toHaveBeenCalledTimes(1);
      expect(manager.lease.version).toBe(2);

      // Advance by second interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockRenew).toHaveBeenCalledTimes(2);
      expect(manager.lease.version).toBe(3);

      await manager.stop(true);
      expect(mockRelease).toHaveBeenCalledWith({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        expectedVersion: 3,
      });
      expect(manager.active).toBe(false);
    });

    it("triggers onLeaseLost and halts renewal loop when renewal encounters LeaseExpiredError", async () => {
      const initialLease = createInitialLease(30000, 1);
      const onLeaseLostSpy = vi.fn();

      const mockAcquire = vi.fn();
      const mockRenew = vi.fn().mockResolvedValue({
        ok: false,
        error: new LeaseExpiredError(sampleTaskId, sampleLeaseId, sampleWorkerId),
      });
      const mockRelease = vi.fn();

      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const manager = new WorkerTaskLeaseManager({
        leaseClient: mockClient,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        initialLease,
        config: { renewalIntervalMs: 500 },
        onLeaseLost: onLeaseLostSpy,
      });

      manager.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockRenew).toHaveBeenCalledTimes(1);
      expect(manager.isLost).toBe(true);
      expect(manager.active).toBe(false);
      expect(manager.isLeaseActive()).toBe(false);
      expect(onLeaseLostSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: "LEASE_EXPIRED" }),
      );

      // Further time does NOT trigger more renewals
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockRenew).toHaveBeenCalledTimes(1);
    });

    it("triggers onLeaseLost on StaleLeaseError", async () => {
      const initialLease = createInitialLease(30000, 1);
      const onLeaseLostSpy = vi.fn();

      const mockAcquire = vi.fn();
      const mockRenew = vi.fn().mockResolvedValue({
        ok: false,
        error: new StaleLeaseError(sampleTaskId, sampleLeaseId),
      });
      const mockRelease = vi.fn();

      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const manager = new WorkerTaskLeaseManager({
        leaseClient: mockClient,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        initialLease,
        onLeaseLost: onLeaseLostSpy,
      });

      const res = await manager.renewNow();
      expect(res.ok).toBe(false);
      expect(manager.isLost).toBe(true);
      expect(onLeaseLostSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: "STALE_LEASE" }),
      );
    });
  });

  describe("TaskExecutionService Integration with Lease Management", () => {
    function createMockAssignment(): TaskAssignment {
      return {
        assignmentId: assignmentId("assign-1"),
        taskId: sampleTaskId,
        runId: runId("run-1"),
        workerId: sampleWorkerId,
        task: {
          id: sampleTaskId,
          name: "Test Task",
          status: "running",
          version: 1,
          description: "",
          attemptCount: 1,
        },
        assignedAt: new Date().toISOString(),
      };
    }

    it("acquires lease before execution and releases upon completion", async () => {
      const initialLease: TaskLease = {
        leaseId: sampleLeaseId,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        acquiredAt: new Date().toISOString(),
        leaseUntil: new Date(Date.now() + 30000).toISOString(),
        version: 2,
      };

      const mockAcquire = vi.fn().mockResolvedValue({ ok: true, value: initialLease });
      const mockRenew = vi.fn().mockResolvedValue({ ok: true, value: { ...initialLease, version: 3 } });
      const mockRelease = vi.fn().mockResolvedValue({ ok: true, value: undefined });

      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const mockExecute = vi.fn().mockResolvedValue({
        taskId: sampleTaskId,
        assignmentId: assignmentId("assign-1"),
        runId: runId("run-1"),
        workerId: sampleWorkerId,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: "success",
      });

      const mockExecutor: ITaskExecutor = {
        execute: mockExecute,
      };

      const mockPublish = vi.fn().mockResolvedValue({
        ok: true,
        value: { id: "evt-1" },
      });

      const mockPublisher: ITaskResultPublisher = {
        publish: mockPublish,
      };

      const service = new TaskExecutionService({
        workerId: sampleWorkerId,
        executor: mockExecutor,
        publisher: mockPublisher,
        leaseClient: mockClient,
      });

      const assignment = createMockAssignment();
      const result = await service.executeAndReport(assignment, {});

      expect(result.ok).toBe(true);
      expect(mockAcquire).toHaveBeenCalledWith({
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        leaseDurationMs: 30000,
        expectedVersion: 1,
      });
      expect(mockExecute).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalledWith({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        expectedVersion: 2,
      });
    });

    it("rejects execution if initial lease acquisition fails", async () => {
      const mockAcquire = vi.fn().mockResolvedValue({
        ok: false,
        error: new LeaseExpiredError(sampleTaskId),
      });
      const mockRenew = vi.fn();
      const mockRelease = vi.fn();

      const mockClient: ITaskLeaseClient = {
        acquire: mockAcquire,
        renew: mockRenew,
        release: mockRelease,
      };

      const mockExecute = vi.fn();
      const mockExecutor: ITaskExecutor = {
        execute: mockExecute,
      };

      const mockPublish = vi.fn();
      const mockPublisher: ITaskResultPublisher = {
        publish: mockPublish,
      };

      const service = new TaskExecutionService({
        workerId: sampleWorkerId,
        executor: mockExecutor,
        publisher: mockPublisher,
        leaseClient: mockClient,
      });

      const assignment = createMockAssignment();
      const result = await service.executeAndReport(assignment, {});

      expect(result.ok).toBe(false);
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });
});
