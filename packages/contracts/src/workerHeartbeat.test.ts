import { heartbeatId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  createWorkerHeartbeatError,
  workerDescriptorSchema,
  workerHeartbeatEnvelopeSchema,
  workerHeartbeatSchema,
  workerObservableStateSchema,
  workerPresenceStateSchema,
} from "./workerHeartbeat.js";

describe("Worker Heartbeat & Presence Contracts (Phase 11D — Commit 1)", () => {
  const currentWorkerId = workerId("worker-test-11d");
  const currentHeartbeatId = heartbeatId("hb-test-01J9XYZ");

  const validHeartbeatPayload = {
    heartbeatId: currentHeartbeatId,
    workerId: currentWorkerId,
    occurredAt: "2026-10-02T12:00:00.000Z",
    lifecycleState: "ready" as const,
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
    capabilities: {
      taskTypes: ["*"],
      tools: ["echo", "calculate"],
      maxConcurrency: 2,
    },
  };

  const validEnvelope = {
    id: currentHeartbeatId,
    type: "worker_heartbeat" as const,
    source: `aegis.worker.${currentWorkerId}`,
    specVersion: "1.0" as const,
    time: "2026-10-02T12:00:00.000Z",
    aggregateId: currentWorkerId,
    aggregateType: "Worker" as const,
    correlationId: "corr-heartbeat-100",
    causationId: "cause-startup-1",
    data: validHeartbeatPayload,
  };

  describe("workerObservableStateSchema", () => {
    it("accepts valid observable worker states", () => {
      const states = ["starting", "ready", "busy", "draining", "stopped", "failed"];
      for (const s of states) {
        expect(workerObservableStateSchema.parse(s)).toBe(s);
      }
    });

    it("rejects invalid observable worker states", () => {
      expect(() => workerObservableStateSchema.parse("offline")).toThrow();
      expect(() => workerObservableStateSchema.parse("RUNNING")).toThrow();
    });
  });

  describe("workerPresenceStateSchema", () => {
    it("accepts valid presence states", () => {
      const states = ["HEALTHY", "STALE", "OFFLINE"];
      for (const s of states) {
        expect(workerPresenceStateSchema.parse(s)).toBe(s);
      }
    });

    it("rejects invalid presence states", () => {
      expect(() => workerPresenceStateSchema.parse("healthy")).toThrow();
      expect(() => workerPresenceStateSchema.parse("DEAD")).toThrow();
    });
  });

  describe("workerHeartbeatSchema", () => {
    it("parses a valid heartbeat payload", () => {
      const parsed = workerHeartbeatSchema.parse(validHeartbeatPayload);
      expect(parsed.workerId).toBe(currentWorkerId);
      expect(parsed.heartbeatId).toBe(currentHeartbeatId);
      expect(parsed.activeTaskCount).toBe(0);
      expect(parsed.lifecycleState).toBe("ready");
    });

    it("allows busy state when activeTaskCount > 0", () => {
      const busyPayload = {
        ...validHeartbeatPayload,
        lifecycleState: "busy",
        activeTaskCount: 2,
      };
      const parsed = workerHeartbeatSchema.parse(busyPayload);
      expect(parsed.lifecycleState).toBe("busy");
      expect(parsed.activeTaskCount).toBe(2);
    });

    it("rejects negative activeTaskCount", () => {
      const invalid = {
        ...validHeartbeatPayload,
        activeTaskCount: -1,
      };
      expect(() => workerHeartbeatSchema.parse(invalid)).toThrow();
    });

    it("rejects non-positive maxConcurrentTasks", () => {
      const invalid = {
        ...validHeartbeatPayload,
        maxConcurrentTasks: 0,
      };
      expect(() => workerHeartbeatSchema.parse(invalid)).toThrow();
    });
  });

  describe("workerHeartbeatEnvelopeSchema", () => {
    it("parses a valid CloudEvents-compliant heartbeat envelope", () => {
      const parsed = workerHeartbeatEnvelopeSchema.parse(validEnvelope);
      expect(parsed.type).toBe("worker_heartbeat");
      expect(parsed.aggregateType).toBe("Worker");
      expect(parsed.aggregateId).toBe(currentWorkerId);
      expect(parsed.id).toBe(currentHeartbeatId);
      expect(parsed.data.heartbeatId).toBe(currentHeartbeatId);
    });

    it("rejects envelope when type is not worker_heartbeat", () => {
      const invalid = {
        ...validEnvelope,
        type: "task_heartbeat",
      };
      expect(() => workerHeartbeatEnvelopeSchema.parse(invalid)).toThrow();
    });

    it("rejects envelope when aggregateType is not Worker", () => {
      const invalid = {
        ...validEnvelope,
        aggregateType: "Task",
      };
      expect(() => workerHeartbeatEnvelopeSchema.parse(invalid)).toThrow();
    });
  });

  describe("workerDescriptorSchema", () => {
    it("parses a valid worker descriptor", () => {
      const descriptor = {
        workerId: currentWorkerId,
        lifecycleState: "ready" as const,
        presenceState: "HEALTHY" as const,
        capabilities: validHeartbeatPayload.capabilities,
        activeTaskCount: 1,
        maxConcurrentTasks: 2,
        registeredAt: "2026-10-02T11:50:00.000Z",
        lastHeartbeatAt: "2026-10-02T12:00:00.000Z",
      };
      const parsed = workerDescriptorSchema.parse(descriptor);
      expect(parsed.workerId).toBe(currentWorkerId);
      expect(parsed.presenceState).toBe("HEALTHY");
    });
  });

  describe("createWorkerHeartbeatError", () => {
    it("creates structured error contracts", () => {
      const err = createWorkerHeartbeatError(
        "HEARTBEAT_PUBLICATION_FAILED",
        "Kafka send error",
        new Error("broker down"),
      );
      expect(err.code).toBe("HEARTBEAT_PUBLICATION_FAILED");
      expect(err.message).toBe("Kafka send error");
      expect(err.cause).toBeDefined();
    });
  });
});
