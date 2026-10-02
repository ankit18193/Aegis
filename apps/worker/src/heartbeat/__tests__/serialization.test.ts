import type { WorkerHeartbeatEnvelope } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  deserializeWorkerHeartbeatEnvelope,
  serializeWorkerHeartbeatEnvelope,
} from "../serialization.js";

describe("WorkerHeartbeat Serialization", () => {
  const sampleEnvelope: WorkerHeartbeatEnvelope = {
    id: heartbeatId("hb-test-100"),
    type: "worker_heartbeat",
    source: "aegis.worker.worker-ser-1",
    specVersion: "1.0",
    time: "2026-10-02T12:00:00.000Z",
    aggregateId: workerId("worker-ser-1"),
    aggregateType: "Worker",
    correlationId: "corr-ser-1",
    data: {
      heartbeatId: heartbeatId("hb-test-100"),
      workerId: workerId("worker-ser-1"),
      occurredAt: "2026-10-02T12:00:00.000Z",
      lifecycleState: "ready",
      activeTaskCount: 2,
      maxConcurrentTasks: 8,
      capabilities: { taskTypes: ["bash", "python"], tools: ["cli"], maxConcurrency: 8 },
    },
  };

  it("serializes and deserializes a WorkerHeartbeatEnvelope losslessly", () => {
    const serializeRes = serializeWorkerHeartbeatEnvelope(sampleEnvelope);
    expect(serializeRes.ok).toBe(true);
    if (!serializeRes.ok) return;

    const deserializeRes = deserializeWorkerHeartbeatEnvelope(serializeRes.value);
    expect(deserializeRes.ok).toBe(true);
    if (!deserializeRes.ok) return;

    expect(deserializeRes.value).toEqual(sampleEnvelope);
  });

  it("deserializes from Buffer", () => {
    const jsonStr = JSON.stringify(sampleEnvelope);
    const buf = Buffer.from(jsonStr, "utf8");

    const result = deserializeWorkerHeartbeatEnvelope(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(sampleEnvelope.id);
  });

  it("returns INVALID_HEARTBEAT_ENVELOPE when payload is null or undefined", () => {
    const nullRes = deserializeWorkerHeartbeatEnvelope(null);
    expect(nullRes.ok).toBe(false);
    if (nullRes.ok) return;
    expect(nullRes.error.code).toBe("INVALID_HEARTBEAT_ENVELOPE");

    const undefRes = deserializeWorkerHeartbeatEnvelope(undefined);
    expect(undefRes.ok).toBe(false);
  });

  it("returns INVALID_HEARTBEAT_ENVELOPE when payload is empty or whitespace", () => {
    const res = deserializeWorkerHeartbeatEnvelope("   ");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_HEARTBEAT_ENVELOPE");
  });

  it("returns INVALID_HEARTBEAT_ENVELOPE when JSON is malformed", () => {
    const res = deserializeWorkerHeartbeatEnvelope("{ not valid json");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_HEARTBEAT_ENVELOPE");
  });

  it("returns INVALID_HEARTBEAT_ENVELOPE when schema validation fails", () => {
    const invalidData = {
      ...sampleEnvelope,
      data: {
        ...sampleEnvelope.data,
        lifecycleState: "UNKNOWN_STATE", // invalid enum
      },
    };

    const res = deserializeWorkerHeartbeatEnvelope(JSON.stringify(invalidData));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_HEARTBEAT_ENVELOPE");
  });
});
