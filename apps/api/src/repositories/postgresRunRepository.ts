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
  TaskLease,
  TaskStateUpdate,
  TaskStatus,
} from "@aegis/contracts";
import {
  LeaseError,
  LeaseExpiredError,
  LeaseOwnershipConflictError,
  StaleLeaseError,
} from "@aegis/contracts";
import {
  err,
  eventId,
  leaseId,
  ok,
  runId,
  taskId,
  workerId,
  workflowId,
  type LeaseId,
  type Result,
  type RunId,
  type TaskId,
  type WorkerId,
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
  outboxEventsTable,
  runEventsTable,
  runsTable,
  tasksTable,
} from "../db/schema.js";
import {
  ConcurrencyConflictError,
  type DomainError,
  TaskNotFoundError,
} from "../domain/errors.js";
import { assertValidTaskTransition } from "../domain/lifecycle.js";
import { toEventEnvelope } from "../events/envelope.js";

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
    runId: row.runId ? runId(row.runId) : undefined,
    name: row.name,
    status: row.status as TaskStatus,
    description: row.description,
    attemptCount: row.attemptCount,
    worker: row.workerId ? workerId(row.workerId) : undefined,
    workerId: row.workerId ? workerId(row.workerId) : undefined,
    version: row.version,
    startedAt: toIsoString(row.startedAt),
    completedAt: toIsoString(row.completedAt),
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    dependencies: row.dependencies ? (row.dependencies as TaskId[]) : undefined,
    leaseId: row.leaseId ? leaseId(row.leaseId) : undefined,
    leaseUntil: toIsoString(row.leaseUntil),
    leaseExpiredAt: toIsoString(row.leaseExpiredAt),
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

  async save(run: Run, events?: readonly RunEvent[]): Promise<void> {
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
              workerId: task.workerId ?? task.worker ?? null,
              version: task.version,
              startedAt: task.startedAt ?? null,
              completedAt: task.completedAt ?? null,
              output: task.output ?? null,
              error: task.error ?? null,
              dependencies: task.dependencies ?? null,
              leaseId: task.leaseId ?? null,
              leaseUntil: task.leaseUntil ?? null,
              leaseExpiredAt: task.leaseExpiredAt ?? null,
            })
            .onConflictDoUpdate({
              target: tasksTable.id,
              set: {
                name: task.name,
                description: task.description,
                status: task.status,
                attemptCount: task.attemptCount,
                workerId: task.workerId ?? task.worker ?? null,
                version: task.version,
                startedAt: task.startedAt ?? null,
                completedAt: task.completedAt ?? null,
                output: task.output ?? null,
                error: task.error ?? null,
                dependencies: task.dependencies ?? null,
                leaseId: task.leaseId ?? null,
                leaseUntil: task.leaseUntil ?? null,
                leaseExpiredAt: task.leaseExpiredAt ?? null,
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

      // 3. Atomically persist domain events and outbox records if provided
      if (events && events.length > 0) {
        for (const event of events) {
          await tx
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

          const envelope = toEventEnvelope(event, {
            source: "aegis.api",
            correlationId: event.runId,
          });
          const createdAt = event.timestamp || new Date().toISOString();

          await tx
            .insert(outboxEventsTable)
            .values({
              id: event.id,
              aggregateId: envelope.aggregateId,
              aggregateType: envelope.aggregateType,
              eventType: envelope.type,
              payload: envelope,
              status: "pending",
              attemptCount: 0,
              createdAt,
            })
            .onConflictDoNothing({ target: outboxEventsTable.id });
        }
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
    await this.db.transaction(async (tx) => {
      await tx
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

      const envelope = toEventEnvelope(event, {
        source: "aegis.api",
        correlationId: event.runId,
      });
      const createdAt = event.timestamp || new Date().toISOString();

      await tx
        .insert(outboxEventsTable)
        .values({
          id: event.id,
          aggregateId: envelope.aggregateId,
          aggregateType: envelope.aggregateType,
          eventType: envelope.type,
          payload: envelope,
          status: "pending",
          attemptCount: 0,
          createdAt,
        })
        .onConflictDoNothing({ target: outboxEventsTable.id });
    });
  }

  async resetToDefaults(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(outboxEventsTable);
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
            workerId: task.workerId ?? task.worker ?? null,
            version: task.version,
            startedAt: task.startedAt ?? null,
            completedAt: task.completedAt ?? null,
            output: task.output ?? null,
            error: task.error ?? null,
            dependencies: task.dependencies ?? null,
            leaseId: task.leaseId ?? null,
            leaseUntil: task.leaseUntil ?? null,
            leaseExpiredAt: task.leaseExpiredAt ?? null,
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

  async updateTaskState(
    targetTaskId: TaskId,
    update: TaskStateUpdate,
    expectedVersion: number,
    event?: RunEvent,
  ): Promise<Result<{ readonly newVersion: number }, ConcurrencyConflictError | DomainError>> {
    return await this.db.transaction(async (tx) => {
      // 1. Fetch current task row to verify existence and check terminal status
      const [existingRow] = await tx
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, targetTaskId))
        .limit(1);

      if (!existingRow) {
        return err(new TaskNotFoundError(targetTaskId));
      }

      // 2. Validate lifecycle transition and check terminal state immutability
      const currentStatus = existingRow.status as TaskStatus;
      const transitionCheck = assertValidTaskTransition(currentStatus, update.status);
      if (!transitionCheck.ok) {
        return transitionCheck;
      }

      // 3. Perform atomic update guarded by expectedVersion
      const updatedRows = await tx
        .update(tasksTable)
        .set({
          status: update.status,
          ...(update.workerId !== undefined ? { workerId: update.workerId } : {}),
          ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
          ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}),
          ...(update.output !== undefined ? { output: update.output } : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
          ...(update.leaseId !== undefined ? { leaseId: update.leaseId } : {}),
          ...(update.leaseUntil !== undefined ? { leaseUntil: update.leaseUntil } : {}),
          ...(update.leaseExpiredAt !== undefined ? { leaseExpiredAt: update.leaseExpiredAt } : {}),
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(tasksTable.id, targetTaskId),
            eq(tasksTable.version, expectedVersion),
          ),
        )
        .returning({ version: tasksTable.version });

      if (updatedRows.length === 0) {
        // Re-fetch to report actual current version
        const [currentRow] = await tx
          .select({ version: tasksTable.version })
          .from(tasksTable)
          .where(eq(tasksTable.id, targetTaskId))
          .limit(1);

        return err(
          new ConcurrencyConflictError(
            targetTaskId,
            expectedVersion,
            currentRow?.version,
          ),
        );
      }

      const firstUpdated = updatedRows[0];
      if (!firstUpdated) {
        return err(new TaskNotFoundError(targetTaskId));
      }

      // 4. Atomically persist domain event and outbox record if provided
      if (event) {
        await tx
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

        const envelope = toEventEnvelope(event, {
          source: "aegis.api",
          correlationId: event.runId,
        });
        const createdAt = event.timestamp || new Date().toISOString();

        await tx
          .insert(outboxEventsTable)
          .values({
            id: event.id,
            aggregateId: envelope.aggregateId,
            aggregateType: envelope.aggregateType,
            eventType: envelope.type,
            payload: envelope,
            status: "pending",
            attemptCount: 0,
            createdAt,
          })
          .onConflictDoNothing({ target: outboxEventsTable.id });
      }

      return ok({ newVersion: firstUpdated.version });
    });
  }

  async acquireTaskLease(
    taskId: TaskId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>> {
    const [row] = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    if (!row) {
      return err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId));
    }

    if (row.status !== "running") {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Task '${taskId}' is in status '${row.status}', must be 'running' to acquire lease`,
          taskId,
          workerId,
        ),
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (
      row.leaseId &&
      row.workerId &&
      row.workerId !== workerId &&
      row.leaseUntil &&
      new Date(row.leaseUntil) > now &&
      !row.leaseExpiredAt
    ) {
      return err(new LeaseOwnershipConflictError(taskId, row.workerId as WorkerId, workerId));
    }

    const newLeaseId = leaseId(`lease-${crypto.randomUUID()}`);
    const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();

    const updatedRows = await this.db
      .update(tasksTable)
      .set({
        leaseId: newLeaseId,
        workerId: workerId,
        leaseUntil: leaseUntil,
        leaseExpiredAt: null,
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.version, expectedVersion),
          eq(tasksTable.status, "running"),
        ),
      )
      .returning({ version: tasksTable.version });

    if (updatedRows.length === 0) {
      const [currentRow] = await this.db
        .select({ version: tasksTable.version })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .limit(1);

      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Concurrency conflict acquiring lease for task '${taskId}': expected version ${String(expectedVersion)}, actual version is ${String(currentRow?.version ?? "unknown")}`,
          taskId,
          workerId,
        ),
      );
    }

    const firstUpdated = updatedRows[0];
    if (!firstUpdated) {
      return err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId));
    }

    return ok({
      leaseId: newLeaseId,
      taskId,
      workerId,
      acquiredAt: nowIso,
      leaseUntil,
      version: firstUpdated.version,
    });
  }

  async renewTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>> {
    const [row] = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    if (!row) {
      return err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId, leaseId));
    }

    if (row.status !== "running") {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Task '${taskId}' is in status '${row.status}', must be 'running' to renew lease`,
          taskId,
          workerId,
          leaseId,
        ),
      );
    }

    if (!row.leaseId || row.leaseId !== leaseId) {
      return err(new StaleLeaseError(taskId, leaseId, row.leaseId ? (row.leaseId as unknown as LeaseId) : undefined));
    }

    if (row.workerId && row.workerId !== workerId) {
      return err(new LeaseOwnershipConflictError(taskId, row.workerId as WorkerId, workerId));
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (row.leaseExpiredAt || (row.leaseUntil && new Date(row.leaseUntil) < now)) {
      return err(new LeaseExpiredError(taskId, leaseId, workerId));
    }

    const newLeaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();

    const updatedRows = await this.db
      .update(tasksTable)
      .set({
        leaseUntil: newLeaseUntil,
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.version, expectedVersion),
          eq(tasksTable.leaseId, leaseId),
          eq(tasksTable.workerId, workerId),
          eq(tasksTable.status, "running"),
          sql`${tasksTable.leaseExpiredAt} IS NULL`,
        ),
      )
      .returning({ version: tasksTable.version });

    if (updatedRows.length === 0) {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Concurrency conflict renewing lease for task '${taskId}'`,
          taskId,
          workerId,
          leaseId,
        ),
      );
    }

    const firstUpdated = updatedRows[0];
    if (!firstUpdated) {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Concurrency conflict renewing lease for task '${taskId}'`,
          taskId,
          workerId,
          leaseId,
        ),
      );
    }

    return ok({
      leaseId,
      taskId,
      workerId,
      acquiredAt: toIsoString(row.startedAt) ?? nowIso,
      leaseUntil: newLeaseUntil,
      version: firstUpdated.version,
    });
  }

  async releaseTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    expectedVersion: number,
  ): Promise<Result<void, LeaseError>> {
    const [row] = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    if (!row) {
      return err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId, leaseId));
    }

    if (row.leaseId && row.leaseId !== leaseId) {
      return err(new StaleLeaseError(taskId, leaseId, row.leaseId ? (row.leaseId as unknown as LeaseId) : undefined));
    }

    if (row.workerId && row.workerId !== workerId) {
      return err(new LeaseOwnershipConflictError(taskId, row.workerId as WorkerId, workerId));
    }

    const updatedRows = await this.db
      .update(tasksTable)
      .set({
        leaseId: null,
        leaseUntil: null,
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.version, expectedVersion),
          eq(tasksTable.leaseId, leaseId),
          eq(tasksTable.workerId, workerId),
        ),
      )
      .returning({ version: tasksTable.version });

    if (updatedRows.length === 0) {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Concurrency conflict releasing lease for task '${taskId}'`,
          taskId,
          workerId,
          leaseId,
        ),
      );
    }

    return ok(undefined);
  }

  async getExpiredTaskLeases(cutoff: Date, limit = 50): Promise<Task[]> {
    const cutoffIso = cutoff.toISOString();
    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.status, "running"),
          sql`${tasksTable.leaseUntil} < ${cutoffIso}::timestamptz`,
          sql`${tasksTable.leaseExpiredAt} IS NULL`,
        ),
      )
      .orderBy(asc(tasksTable.leaseUntil))
      .limit(limit);

    return rows.map(mapTaskRowToTask);
  }

  async markTaskLeaseExpired(
    taskId: TaskId,
    expectedVersion: number,
    expiredAt: Date,
    event?: RunEvent,
  ): Promise<boolean> {
    const expiredAtIso = expiredAt.toISOString();

    return await this.db.transaction(async (tx) => {
      const updatedRows = await tx
        .update(tasksTable)
        .set({
          leaseExpiredAt: expiredAtIso,
          version: expectedVersion + 1,
        })
        .where(
          and(
            eq(tasksTable.id, taskId),
            eq(tasksTable.version, expectedVersion),
            eq(tasksTable.status, "running"),
            sql`${tasksTable.leaseUntil} < ${expiredAtIso}::timestamptz`,
            sql`${tasksTable.leaseExpiredAt} IS NULL`,
          ),
        )
        .returning({ version: tasksTable.version });

      if (updatedRows.length === 0) {
        return false;
      }

      if (event) {
        await tx
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

        const envelope = toEventEnvelope(event, {
          source: "aegis.api",
          correlationId: event.runId,
        });
        const createdAt = event.timestamp || new Date().toISOString();

        await tx
          .insert(outboxEventsTable)
          .values({
            id: event.id,
            aggregateId: envelope.aggregateId,
            aggregateType: envelope.aggregateType,
            eventType: envelope.type,
            payload: envelope,
            status: "pending",
            attemptCount: 0,
            createdAt,
          })
          .onConflictDoNothing({ target: outboxEventsTable.id });
      }

      return true;
    });
  }
}
