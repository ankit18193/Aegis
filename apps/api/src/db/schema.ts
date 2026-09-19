/**
 * Relational database schema for Aegis execution platform using Drizzle ORM.
 * Defines runs, tasks, and run_events tables with relational foreign keys,
 * query indexes, and typed constraints mapped from canonical contracts.
 */

import type { RunResult } from "@aegis/contracts";
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Runs Table — Root aggregate for execution runs.
 */
export const runsTable = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    goal: text("goal").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    workflowId: text("workflow_id").notNull(),
    workflowName: text("workflow_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    result: jsonb("result").$type<RunResult>(),
  },
  (table) => [
    index("runs_status_idx").on(table.status),
    index("runs_created_at_idx").on(table.createdAt.desc()),
  ],
);

/**
 * Tasks Table — Execution tasks belonging to a run.
 * Relational foreign key cascades on run deletion.
 */
export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    output: text("output"),
    error: text("error"),
    dependencies: jsonb("dependencies").$type<string[]>(),
  },
  (table) => [
    index("tasks_run_id_idx").on(table.runId),
  ],
);

/**
 * Run Events Table — Audit and timeline events recorded for a run.
 * Relational foreign key cascades on run deletion.
 */
export const runEventsTable = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "string" }).notNull(),
    message: text("message").notNull(),
    taskId: text("task_id"),
    taskName: text("task_name"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("run_events_run_id_timestamp_idx").on(table.runId, table.timestamp),
  ],
);

/**
 * Drizzle Relations Definitions.
 */
export const runsRelations = relations(runsTable, ({ many }) => ({
  tasks: many(tasksTable),
  events: many(runEventsTable),
}));

export const tasksRelations = relations(tasksTable, ({ one }) => ({
  run: one(runsTable, {
    fields: [tasksTable.runId],
    references: [runsTable.id],
  }),
}));

export const runEventsRelations = relations(runEventsTable, ({ one }) => ({
  run: one(runsTable, {
    fields: [runEventsTable.runId],
    references: [runsTable.id],
  }),
}));

export type RunRecord = typeof runsTable.$inferSelect;
export type InsertRunRecord = typeof runsTable.$inferInsert;

export type TaskRecord = typeof tasksTable.$inferSelect;
export type InsertTaskRecord = typeof tasksTable.$inferInsert;

export type RunEventRecord = typeof runEventsTable.$inferSelect;
export type InsertRunEventRecord = typeof runEventsTable.$inferInsert;
