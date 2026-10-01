import type { EventEnvelope, RunEvent } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import { InMemoryEventSubscriber } from "../../inMemorySubscriber.js";
import { AuditSubscriber, LIFECYCLE_EVENT_TYPES } from "../auditSubscriber.js";

describe("AuditSubscriber (Phase 10C — Commit 3)", () => {
  let seq = 1;
  const makeEnvelope = (type: RunEvent["type"], runIdVal = "run-audit-1", taskName?: string): EventEnvelope => {
    seq += 1;
    const nowStr = Date.now().toString();
    const seqStr = seq.toString();
    return {
      id: eventId(`evt-${type}-${nowStr}-${seqStr}`),
      type,
      source: "aegis.execution",
      specVersion: "1.0",
      time: "2026-10-01T20:30:00.000Z",
      aggregateId: runId(runIdVal),
      aggregateType: "ExecutionRun",
      correlationId: runIdVal,
      data: {
        id: eventId(`evt-data-${nowStr}-${seqStr}`),
        runId: runId(runIdVal),
        type,
        severity: "info",
        timestamp: "2026-10-01T20:30:00.000Z",
        message: `Event message for ${type}`,
        taskId: taskName ? taskId("task-1") : undefined,
        taskName,
      },
    };
  };

  it("subscribes to all canonical lifecycle event types upon register()", async () => {
    const subscriber = new InMemoryEventSubscriber();
    const audit = new AuditSubscriber(subscriber);

    audit.register();
    await subscriber.start();

    // Verify all lifecycle types are handled
    for (const type of LIFECYCLE_EVENT_TYPES) {
      const envelope = makeEnvelope(type);
      const result = await subscriber.dispatch(envelope, {
        topic: "aegis.events",
        partition: 0,
        offset: "101",
      });
      expect(result.ok).toBe(true);
    }

    expect(audit.getRecords()).toHaveLength(LIFECYCLE_EVENT_TYPES.length);
  });

  it("captures structured audit records with metadata and logs appropriately", async () => {
    const subscriber = new InMemoryEventSubscriber();
    const infoSpy = vi.fn();
    const mockLogger: Logger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const audit = new AuditSubscriber(subscriber, mockLogger);
    audit.register();
    await subscriber.start();

    const env = makeEnvelope("task_started", "run-audit-42", "Task Analysis");
    const result = await subscriber.dispatch(env, {
      topic: "aegis.events",
      partition: 1,
      offset: "420",
    });

    expect(result.ok).toBe(true);

    const records = audit.getRecords();
    expect(records).toHaveLength(1);

    const rec = records[0];
    expect(rec).toBeDefined();
    if (rec) {
      expect(rec.eventId).toBe(env.id);
      expect(rec.runId).toBe("run-audit-42");
      expect(rec.type).toBe("task_started");
      expect(rec.topic).toBe("aegis.events");
      expect(rec.partition).toBe(1);
      expect(rec.offset).toBe("420");
      expect(rec.taskName).toBe("Task Analysis");
    }

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[AUDIT] Execution event task_started observed"),
      expect.objectContaining({
        runId: "run-audit-42",
        type: "task_started",
        offset: "420",
        partition: 1,
      }),
    );
  });

  it("filters audit records by runId and supports clear()", async () => {
    const subscriber = new InMemoryEventSubscriber();
    const audit = new AuditSubscriber(subscriber);
    audit.register();
    await subscriber.start();

    await subscriber.dispatch(makeEnvelope("run_created", "run-A"));
    await subscriber.dispatch(makeEnvelope("task_started", "run-A", "Step A"));
    await subscriber.dispatch(makeEnvelope("run_created", "run-B"));

    expect(audit.getRecordsByRunId("run-A")).toHaveLength(2);
    expect(audit.getRecordsByRunId("run-B")).toHaveLength(1);
    expect(audit.getRecordsByRunId("run-C")).toHaveLength(0);

    audit.clear();
    expect(audit.getRecords()).toHaveLength(0);
  });

  it("unregisters cleanly and stops capturing subsequent events", async () => {
    const subscriber = new InMemoryEventSubscriber();
    const audit = new AuditSubscriber(subscriber);
    audit.register();
    await subscriber.start();

    await subscriber.dispatch(makeEnvelope("run_created", "run-unregister"));
    expect(audit.getRecords()).toHaveLength(1);

    audit.unregister();

    await subscriber.dispatch(makeEnvelope("run_completed", "run-unregister"));
    // Count remains 1 since subscriber was unregistered
    expect(audit.getRecords()).toHaveLength(1);
  });
});
