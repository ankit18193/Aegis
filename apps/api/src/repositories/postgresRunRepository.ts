/**
 * PostgreSQL implementation of IRunRepository using Drizzle ORM.
 * Implements durable execution run, task, and audit event persistence
 * with relational foreign keys, transactional task synchronization,
 * and zero domain coupling.
 */

import type {
  EventSeverity,
  EventType,
  Run,
  RunEvent,
  RunStatus,
  RunSummary,
  Task,
  TaskStatus,
} from "@aegis/contracts";
import {
  eventId,
  runId,
  taskId,
  workflowId,
  type RunId,
  type TaskId,
} from "@aegis/types";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { DatabaseContext } from "../db/client.js";
import {
  runEventsTable,
  runsTable,
  tasksTable,
} from "../db/schema.js";

import type {
  EventFilterOptions,
  FindAllRunsResult,
  IRunRepository,
  RunFilterOptions,
} from "./runRepository.js";
import { getInitialSeedEvents, getInitialSeedRuns } from "./seeds.js";

function toIsoString(dateOrStr: string | Date | null | undefined): string | undefined {
  if (!dateOrStr) return undefined;
  if (dateOrStr instanceof Date) return dateOrStr.toISOString();
  return new Date(dateOrStr).toISOString();
}

function toIsoStringRequired(dateOrStr: string | Date): string {
  if (dateOrStr instanceof Date) return dateOrStr.toISOString();
  return new Date(dateOrStr).toISOString();
}

function mapTaskRowToTask(row: typeof tasksTable.$inferSelect): Task {
  return {
    id: taskId(row.id),
    name: row.name,
    status: row.status as TaskStatus,
    description: row.description,
    attemptCount: row.attemptCount,
    startedAt: toIsoString(row.startedAt),
    completedAt: toIsoString(row.completedAt),
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    dependencies: row.dependencies ? (row.dependencies as TaskId[]) : undefined,
  };
}

function mapRunRowToRun(
  row: typeof runsTable.$inferSelect,
  tasks: Task[],
): Run {
  return {
    id: runId(row.id),
    goal: row.goal,
    status: row.status as RunStatus,
    createdAt: toIsoStringRequired(row.createdAt),
    updatedAt: toIsoStringRequired(row.updatedAt),
    progress: row.progress,
    workflow: {
      id: workflowId(row.workflowId),
      name: row.workflowName,
      tasks: structuredClone(tasks),
    },
    tasks: structuredClone(tasks),
    result: row.result ?? undefined,
  };
}

function mapEventRowToEvent(row: typeof runEventsTable.$inferSelect): RunEvent {
  return {
    id: eventId(row.id),
    runId: runId(row.runId),
    type: row.type as EventType,
    severity: row.severity as EventSeverity,
    timestamp: toIsoStringRequired(row.timestamp),
    message: row.message,
    taskId: row.taskId ? taskId(row.taskId) : undefined,
    taskName: row.taskName ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

export class PostgresRunRepository implements IRunRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: PostgresJsDatabase<any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(dbOrContext: PostgresJsDatabase<any> | DatabaseContext) {
    this.db = "db" in dbOrContext ? dbOrContext.db : dbOrContext;
  }

  async findById(id: RunId): Promise<Run | null> {
    const [runRow] = await this.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.id, id))
      .limit(1);

    if (!runRow) {
      return null;
    }

    const taskRows = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.runId, id))
      .orderBy(asc(tasksTable.id));

    const tasks = taskRows.map(mapTaskRowToTask);
    return mapRunRowToRun(runRow, tasks);
  }

  async findAll(options?: RunFilterOptions): Promise<FindAllRunsResult> {
    const filterConditions: SQL[] = [];

    if (options?.status) {
      filterConditions.push(eq(runsTable.status, options.status));
    }

    if (options?.query && options.query.trim().length > 0) {
      filterConditions.push(ilike(runsTable.goal, `%${options.query.trim()}%`));
    }

    // 1. Calculate totalCount matching filters
    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runsTable)
      .where(filterConditions.length > 0 ? and(...filterConditions) : undefined);

    const totalCount = countRow?.count ?? 0;

    // 2. Prepare paginated query
    const queryConditions = [...filterConditions];

    if (options?.cursor) {
      const [cursorRun] = await this.db
        .select({ createdAt: runsTable.createdAt })
        .from(runsTable)
        .where(eq(runsTable.id, options.cursor))
        .limit(1);

      if (cursorRun) {
        queryConditions.push(
          sql`(${runsTable.createdAt} < ${cursorRun.createdAt} OR (${runsTable.createdAt} = ${cursorRun.createdAt} AND ${runsTable.id} < ${options.cursor}))`,
        );
      }
    }

    const limit = options?.limit ?? 20;

    const rows = await this.db
      .select({
        id: runsTable.id,
        goal: runsTable.goal,
        status: runsTable.status,
        createdAt: runsTable.createdAt,
        updatedAt: runsTable.updatedAt,
        progress: runsTable.progress,
        totalTasks: sql<number>`count(${tasksTable.id})::int`,
        completedTasks: sql<number>`count(case when ${tasksTable.status} = 'completed' then 1 end)::int`,
      })
      .from(runsTable)
      .leftJoin(tasksTable, eq(tasksTable.runId, runsTable.id))
      .where(queryConditions.length > 0 ? and(...queryConditions) : undefined)
      .groupBy(runsTable.id)
      .orderBy(desc(runsTable.createdAt), desc(runsTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const paginated = hasMore ? rows.slice(0, limit) : rows;

    const items: RunSummary[] = paginated.map((r) => ({
      id: runId(r.id),
      goal: r.goal,
      status: r.status as RunStatus,
      createdAt: toIsoStringRequired(r.createdAt),
      updatedAt: toIsoStringRequired(r.updatedAt),
      progress: r.progress,
      totalTasks: r.totalTasks,
      completedTasks: r.completedTasks,
    }));

    return {
      items,
      totalCount,
      hasMore,
    };
  }

  async save(run: Run): Promise<void> {
    await this.db.transaction(async (tx) => {
      // 1. Upsert run record
      await tx
        .insert(runsTable)
        .values({
          id: run.id,
          goal: run.goal,
          status: run.status,
          progress: run.progress,
          workflowId: run.workflow.id,
          workflowName: run.workflow.name,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          result: run.result ?? null,
        })
        .onConflictDoUpdate({
          target: runsTable.id,
          set: {
            goal: run.goal,
            status: run.status,
            progress: run.progress,
            workflowId: run.workflow.id,
            workflowName: run.workflow.name,
            updatedAt: run.updatedAt,
            result: run.result ?? null,
          },
        });

      // 2. Transactional task synchronization (Lock 2: avoid blind delete/reinsert)
      if (run.tasks.length > 0) {
        for (const task of run.tasks) {
          await tx
            .insert(tasksTable)
            .values({
              id: task.id,
              runId: run.id,
              name: task.name,
              description: task.description,
              status: task.status,
              attemptCount: task.attemptCount,
              startedAt: task.startedAt ?? null,
              completedAt: task.completedAt ?? null,
              output: task.output ?? null,
              error: task.error ?? null,
              dependencies: task.dependencies ?? null,
            })
            .onConflictDoUpdate({
              target: tasksTable.id,
              set: {
                name: task.name,
                description: task.description,
                status: task.status,
                attemptCount: task.attemptCount,
                startedAt: task.startedAt ?? null,
                completedAt: task.completedAt ?? null,
                output: task.output ?? null,
                error: task.error ?? null,
                dependencies: task.dependencies ?? null,
              },
            });
        }

        const currentTaskIds = run.tasks.map((t) => t.id as string);
        await tx
          .delete(tasksTable)
          .where(
            and(
              eq(tasksTable.runId, run.id),
              notInArray(tasksTable.id, currentTaskIds),
            ),
          );
      } else {
        await tx.delete(tasksTable).where(eq(tasksTable.runId, run.id));
      }
    });
  }

  async findEvents(runId: RunId, options?: EventFilterOptions): Promise<RunEvent[]> {
    const conditions: SQL[] = [eq(runEventsTable.runId, runId)];

    if (options?.severity) {
      conditions.push(eq(runEventsTable.severity, options.severity));
    }

    if (options?.type) {
      conditions.push(eq(runEventsTable.type, options.type));
    }

    if (options?.cursor) {
      const [cursorEvent] = await this.db
        .select({ timestamp: runEventsTable.timestamp })
        .from(runEventsTable)
        .where(eq(runEventsTable.id, options.cursor))
        .limit(1);

      if (cursorEvent) {
        conditions.push(
          sql`(${runEventsTable.timestamp} > ${cursorEvent.timestamp} OR (${runEventsTable.timestamp} = ${cursorEvent.timestamp} AND ${runEventsTable.id} > ${options.cursor}))`,
        );
      }
    }

    const limit = options?.limit ?? 50;

    const rows = await this.db
      .select()
      .from(runEventsTable)
      .where(and(...conditions))
      .orderBy(asc(runEventsTable.timestamp), asc(runEventsTable.id))
      .limit(limit);

    return rows.map(mapEventRowToEvent);
  }

  async saveEvent(event: RunEvent): Promise<void> {
    await this.db
      .insert(runEventsTable)
      .values({
        id: event.id,
        runId: event.runId,
        type: event.type,
        severity: event.severity,
        timestamp: event.timestamp,
        message: event.message,
        taskId: event.taskId ?? null,
        taskName: event.taskName ?? null,
        metadata: event.metadata ?? null,
      })
      .onConflictDoUpdate({
        target: runEventsTable.id,
        set: {
          type: event.type,
          severity: event.severity,
          timestamp: event.timestamp,
          message: event.message,
          taskId: event.taskId ?? null,
          taskName: event.taskName ?? null,
          metadata: event.metadata ?? null,
        },
      });
  }

  async resetToDefaults(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(runEventsTable);
      await tx.delete(tasksTable);
      await tx.delete(runsTable);

      const seedRuns = getInitialSeedRuns();
      for (const run of seedRuns) {
        await tx.insert(runsTable).values({
          id: run.id,
          goal: run.goal,
          status: run.status,
          progress: run.progress,
          workflowId: run.workflow.id,
          workflowName: run.workflow.name,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          result: run.result ?? null,
        });

        for (const task of run.tasks) {
          await tx.insert(tasksTable).values({
            id: task.id,
            runId: run.id,
            name: task.name,
            description: task.description,
            status: task.status,
            attemptCount: task.attemptCount,
            startedAt: task.startedAt ?? null,
            completedAt: task.completedAt ?? null,
            output: task.output ?? null,
            error: task.error ?? null,
            dependencies: task.dependencies ?? null,
          });
        }
      }

      const seedEvents = getInitialSeedEvents();
      for (const eventList of Object.values(seedEvents)) {
        for (const event of eventList) {
          await tx.insert(runEventsTable).values({
            id: event.id,
            runId: event.runId,
            type: event.type,
            severity: event.severity,
            timestamp: event.timestamp,
            message: event.message,
            taskId: event.taskId ?? null,
            taskName: event.taskName ?? null,
            metadata: event.metadata ?? null,
          });
        }
      }
    });
  }
}
