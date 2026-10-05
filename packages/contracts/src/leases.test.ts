import { leaseId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { ITaskLeaseClient } from "./leases.js";
import {
  DEFAULT_TASK_LEASE_CONFIG,
  LeaseError,
  LeaseExpiredError,
  LeaseOwnershipConflictError,
  StaleLeaseError,
  leaseIdSchema,
  taskLeaseAcquireRequestSchema,
  taskLeaseConfigSchema,
  taskLeaseReleaseRequestSchema,
  taskLeaseRenewRequestSchema,
  taskLeaseSchema,
} from "./leases.js";
import { taskSchema, taskStateUpdateSchema } from "./runs.js";

describe("Lease Contracts & Schemas", () => {
  const sampleTaskId = taskId("task-100");
  const sampleWorkerId = workerId("worker-alpha");
  const sampleLeaseId = leaseId("lease-999");
  const sampleNow = "2026-10-05T12:00:00.000Z";
  const sampleUntil = "2026-10-05T12:00:30.000Z";

  describe("leaseIdSchema", () => {
    it("parses valid non-empty string and brands it as LeaseId", () => {
      const parsed = leaseIdSchema.parse("lease-123");
      expect(parsed).toBe("lease-123");
    });

    it("rejects empty string", () => {
      expect(() => leaseIdSchema.parse("")).toThrow();
    });
  });

  describe("taskLeaseSchema", () => {
    it("validates a complete active TaskLease", () => {
      const parsed = taskLeaseSchema.parse({
        leaseId: sampleLeaseId,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        acquiredAt: sampleNow,
        leaseUntil: sampleUntil,
        version: 1,
      });

      expect(parsed.leaseId).toBe(sampleLeaseId);
      expect(parsed.taskId).toBe(sampleTaskId);
      expect(parsed.workerId).toBe(sampleWorkerId);
      expect(parsed.version).toBe(1);
      expect(parsed.leaseExpiredAt).toBeUndefined();
    });

    it("validates a lease marked as expired", () => {
      const expiredAt = "2026-10-05T12:00:31.000Z";
      const parsed = taskLeaseSchema.parse({
        leaseId: sampleLeaseId,
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        acquiredAt: sampleNow,
        leaseUntil: sampleUntil,
        leaseExpiredAt: expiredAt,
        version: 2,
      });

      expect(parsed.leaseExpiredAt).toBe(expiredAt);
      expect(parsed.version).toBe(2);
    });

    it("rejects invalid version (< 1)", () => {
      expect(() =>
        taskLeaseSchema.parse({
          leaseId: sampleLeaseId,
          taskId: sampleTaskId,
          workerId: sampleWorkerId,
          acquiredAt: sampleNow,
          leaseUntil: sampleUntil,
          version: 0,
        }),
      ).toThrow();
    });
  });

  describe("Request Schemas", () => {
    it("validates acquire request with defaults", () => {
      const req = taskLeaseAcquireRequestSchema.parse({
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        expectedVersion: 1,
      });

      expect(req.leaseDurationMs).toBe(30000);
      expect(req.expectedVersion).toBe(1);
    });

    it("validates renew request", () => {
      const req = taskLeaseRenewRequestSchema.parse({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        leaseDurationMs: 45000,
        expectedVersion: 2,
      });

      expect(req.leaseDurationMs).toBe(45000);
      expect(req.expectedVersion).toBe(2);
    });

    it("validates release request", () => {
      const req = taskLeaseReleaseRequestSchema.parse({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        expectedVersion: 3,
      });

      expect(req.taskId).toBe(sampleTaskId);
      expect(req.expectedVersion).toBe(3);
    });
  });

  describe("Timing Configuration", () => {
    it("provides standard defaults", () => {
      expect(DEFAULT_TASK_LEASE_CONFIG.leaseDurationMs).toBe(30000);
      expect(DEFAULT_TASK_LEASE_CONFIG.renewalIntervalMs).toBe(10000);
      expect(DEFAULT_TASK_LEASE_CONFIG.gracePeriodMs).toBe(5000);
      expect(DEFAULT_TASK_LEASE_CONFIG.sweepIntervalMs).toBe(5000);
    });

    it("parses valid custom config", () => {
      const custom = taskLeaseConfigSchema.parse({
        leaseDurationMs: 60000,
        renewalIntervalMs: 20000,
        gracePeriodMs: 10000,
        sweepIntervalMs: 10000,
      });
      expect(custom.leaseDurationMs).toBe(60000);
    });
  });

  describe("Typed Lease Errors", () => {
    it("instantiates base LeaseError correctly", () => {
      const err = new LeaseError("CONCURRENCY_CONFLICT", "Conflict detected", sampleTaskId, sampleWorkerId);
      expect(err.code).toBe("CONCURRENCY_CONFLICT");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.workerId).toBe(sampleWorkerId);
      expect(err.name).toBe("LeaseError");
    });

    it("instantiates LeaseExpiredError correctly", () => {
      const err = new LeaseExpiredError(sampleTaskId, sampleLeaseId, sampleWorkerId);
      expect(err.code).toBe("LEASE_EXPIRED");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.leaseId).toBe(sampleLeaseId);
      expect(err.workerId).toBe(sampleWorkerId);
      expect(err.message).toContain("expired");
    });

    it("instantiates LeaseOwnershipConflictError correctly", () => {
      const otherWorker = workerId("worker-beta");
      const err = new LeaseOwnershipConflictError(sampleTaskId, sampleWorkerId, otherWorker);
      expect(err.code).toBe("LEASE_OWNERSHIP_CONFLICT");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain("worker-alpha");
      expect(err.message).toContain("worker-beta");
    });

    it("instantiates StaleLeaseError correctly", () => {
      const staleId = leaseId("lease-stale");
      const err = new StaleLeaseError(sampleTaskId, staleId, sampleLeaseId);
      expect(err.code).toBe("STALE_LEASE");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain("lease-stale");
      expect(err.message).toContain("lease-999");
    });
  });

  describe("ITaskLeaseClient Contract Shape", () => {
    it("allows implementing the lease client interface", async () => {
      const mockClient: ITaskLeaseClient = {
        acquire: (req) =>
          Promise.resolve({
            ok: true,
            value: {
              leaseId: sampleLeaseId,
              taskId: req.taskId,
              workerId: req.workerId,
              acquiredAt: sampleNow,
              leaseUntil: sampleUntil,
              version: req.expectedVersion,
            },
          }),
        renew: (req) =>
          Promise.resolve({
            ok: true,
            value: {
              leaseId: req.leaseId,
              taskId: req.taskId,
              workerId: req.workerId,
              acquiredAt: sampleNow,
              leaseUntil: sampleUntil,
              version: req.expectedVersion + 1,
            },
          }),
        release: () =>
          Promise.resolve({
            ok: true,
            value: undefined,
          }),
      };

      const acqRes = await mockClient.acquire({
        taskId: sampleTaskId,
        workerId: sampleWorkerId,
        leaseDurationMs: 30000,
        expectedVersion: 1,
      });
      expect(acqRes.ok).toBe(true);

      const renewRes = await mockClient.renew({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        leaseDurationMs: 30000,
        expectedVersion: 1,
      });
      expect(renewRes.ok).toBe(true);

      const relRes = await mockClient.release({
        taskId: sampleTaskId,
        leaseId: sampleLeaseId,
        workerId: sampleWorkerId,
        expectedVersion: 2,
      });
      expect(relRes.ok).toBe(true);
    });
  });

  describe("Task Schema Lease Extensions", () => {
    it("accepts task schema with lease metadata", () => {
      const task = taskSchema.parse({
        id: sampleTaskId,
        name: "Test Task",
        status: "running",
        workerId: sampleWorkerId,
        version: 1,
        leaseId: sampleLeaseId,
        leaseUntil: sampleUntil,
      });

      expect(task.leaseId).toBe(sampleLeaseId);
      expect(task.leaseUntil).toBe(sampleUntil);
      expect(task.leaseExpiredAt).toBeUndefined();
    });

    it("accepts taskStateUpdateSchema with lease metadata", () => {
      const update = taskStateUpdateSchema.parse({
        status: "running",
        workerId: sampleWorkerId,
        leaseId: sampleLeaseId,
        leaseUntil: sampleUntil,
      });

      expect(update.leaseId).toBe(sampleLeaseId);
      expect(update.leaseUntil).toBe(sampleUntil);
    });
  });
});
