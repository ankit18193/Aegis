import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { runEventsTable, runsTable, tasksTable } from "./schema.js";

describe("Database Schema Definitions", () => {
  it("defines canonical relational table names", () => {
    expect(getTableName(runsTable)).toBe("runs");
    expect(getTableName(tasksTable)).toBe("tasks");
    expect(getTableName(runEventsTable)).toBe("run_events");
  });

  it("defines primary key columns on all tables", () => {
    expect(runsTable.id).toBeDefined();
    expect(tasksTable.id).toBeDefined();
    expect(runEventsTable.id).toBeDefined();
  });

  it("defines relational foreign keys on tasks and run_events referencing runs", () => {
    expect(tasksTable.runId).toBeDefined();
    expect(runEventsTable.runId).toBeDefined();
  });
});
