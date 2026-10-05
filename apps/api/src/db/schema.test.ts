import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { outboxEventsTable, runEventsTable, runsTable, tasksTable } from "./schema.js";

describe("Database Schema Definitions", () => {
  it("defines canonical relational table names", () => {
    expect(getTableName(runsTable)).toBe("runs");
    expect(getTableName(tasksTable)).toBe("tasks");
    expect(getTableName(runEventsTable)).toBe("run_events");
    expect(getTableName(outboxEventsTable)).toBe("outbox_events");
  });

  it("defines primary key columns on all tables", () => {
    expect(runsTable.id).toBeDefined();
    expect(tasksTable.id).toBeDefined();
    expect(runEventsTable.id).toBeDefined();
    expect(outboxEventsTable.id).toBeDefined();
  });

  it("defines relational foreign keys on tasks and run_events referencing runs", () => {
    expect(tasksTable.runId).toBeDefined();
    expect(runEventsTable.runId).toBeDefined();
  });

  it("defines durable execution columns on tasksTable (Phase 12A)", () => {
    expect(tasksTable.version).toBeDefined();
    expect(tasksTable.workerId).toBeDefined();
    expect(tasksTable.status).toBeDefined();
    expect(tasksTable.attemptCount).toBeDefined();
  });

  it("defines transactional outbox columns on outboxEventsTable (Phase 12C)", () => {
    expect(outboxEventsTable.aggregateId).toBeDefined();
    expect(outboxEventsTable.aggregateType).toBeDefined();
    expect(outboxEventsTable.eventType).toBeDefined();
    expect(outboxEventsTable.payload).toBeDefined();
    expect(outboxEventsTable.status).toBeDefined();
    expect(outboxEventsTable.attemptCount).toBeDefined();
    expect(outboxEventsTable.lockedUntil).toBeDefined();
    expect(outboxEventsTable.lockedBy).toBeDefined();
    expect(outboxEventsTable.publishedAt).toBeDefined();
    expect(outboxEventsTable.createdAt).toBeDefined();
  });
});

