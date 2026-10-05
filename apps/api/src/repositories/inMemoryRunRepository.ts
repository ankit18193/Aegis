import type {
  CreateOutboxRecord,
  OutboxRecord,
  RecoveryError,
  Run,
  RunEvent,
  RunSummary,
  Task,
  TaskLease,
  TaskStateUpdate,
} from "@aegis/contracts";
import {
  LeaseError,
  LeaseExpiredError,
  LeaseOwnershipConflictError,
  RecoveryConflictError,
  StaleLeaseError,
  TaskNotRecoverableError,
} from "@aegis/contracts";
import type { LeaseId, Result, RunId, TaskId, WorkerId } from "@aegis/types";
import { err, leaseId, ok, outboxEventId } from "@aegis/types";

import { ConcurrencyConflictError, type DomainError, TaskNotFoundError } from "../domain/errors.js";
import { assertValidTaskTransition } from "../domain/lifecycle.js";
import { toEventEnvelope } from "../events/envelope.js";

import type { IOutboxRepository } from "./outboxRepository.js";
import type {
  EventFilterOptions,
  FailExhaustedTaskParams,
  FindAllRunsResult,
  IRunRepository,
  ReassignTaskParams,
  RunFilterOptions,
} from "./runRepository.js";
import { getInitialSeedEvents, getInitialSeedRuns } from "./seeds.js";

export class InMemoryRunRepository implements IRunRepository {
  private readonly runs = new Map<RunId, Run>();
  private readonly events = new Map<RunId, RunEvent[]>();
  private readonly outboxEvents: OutboxRecord[] = [];
  private readonly outboxRepo: IOutboxRepository | undefined;

  constructor(seed = true, outboxRepo?: IOutboxRepository) {
    this.outboxRepo = outboxRepo;
    if (seed) {
      this.populateSeeds();
    }
  }

  private populateSeeds(): void {
    this.runs.clear();
    this.events.clear();

    const seedRuns = getInitialSeedRuns();
    for (const run of seedRuns) {
      this.runs.set(run.id, structuredClone(run));
    }

    const seedEvents = getInitialSeedEvents();
    for (const [runIdKey, eventList] of Object.entries(seedEvents)) {
      this.events.set(runIdKey as RunId, structuredClone(eventList));
    }
  }

  findById(id: RunId): Promise<Run | null> {
    const run = this.runs.get(id);
    return Promise.resolve(run ? structuredClone(run) : null);
  }

  findAll(options?: RunFilterOptions): Promise<FindAllRunsResult> {
    let list = Array.from(this.runs.values());

    if (options?.status) {
      list = list.filter((r) => r.status === options.status);
    }

    if (options?.query && options.query.trim().length > 0) {
      const q = options.query.trim().toLowerCase();
      list = list.filter((r) => r.goal.toLowerCase().includes(q));
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const totalCount = list.length;

    // Apply cursor pagination if cursor is provided
    if (options?.cursor) {
      const cursorIndex = list.findIndex((r) => r.id === options.cursor);
      if (cursorIndex !== -1) {
        list = list.slice(cursorIndex + 1);
      }
    }

    const limit = options?.limit ?? 20;
    const hasMore = list.length > limit;
    const paginated = list.slice(0, limit);

    const items: RunSummary[] = paginated.map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      progress: r.progress,
      totalTasks: r.tasks.length,
      completedTasks: r.tasks.filter((t) => t.status === "completed").length,
    }));

    return Promise.resolve({
      items: structuredClone(items),
      totalCount,
      hasMore,
    });
  }

  save(run: Run, events?: readonly RunEvent[]): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
    if (events && events.length > 0) {
      const list = this.events.get(run.id) ?? [];
      for (const event of events) {
        list.push(structuredClone(event));
        const outboxRecord = this.toOutboxRecord(event);
        this.outboxEvents.push(outboxRecord);
        if (this.outboxRepo) {
          void this.outboxRepo.insert([outboxRecord]);
        }
      }
      this.events.set(run.id, list);
    }
    return Promise.resolve();
  }

  findEvents(runId: RunId, options?: EventFilterOptions): Promise<RunEvent[]> {
    const list = this.events.get(runId) ?? [];
    let filtered = [...list];

    if (options?.severity) {
      filtered = filtered.filter((e) => e.severity === options.severity);
    }

    if (options?.type) {
      filtered = filtered.filter((e) => e.type === options.type);
    }

    // Sort chronologically ascending
    filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (options?.cursor) {
      const cursorIndex = filtered.findIndex((e) => e.id === options.cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const limit = options?.limit ?? 50;
    const paginated = filtered.slice(0, limit);

    return Promise.resolve(structuredClone(paginated));
  }

  saveEvent(event: RunEvent): Promise<void> {
    const existing = this.events.get(event.runId) ?? [];
    existing.push(structuredClone(event));
    this.events.set(event.runId, existing);
    const outboxRecord = this.toOutboxRecord(event);
    this.outboxEvents.push(outboxRecord);
    if (this.outboxRepo) {
      void this.outboxRepo.insert([outboxRecord]);
    }
    return Promise.resolve();
  }

  resetToDefaults(): Promise<void> {
    this.outboxEvents.length = 0;
    this.populateSeeds();
    return Promise.resolve();
  }

  updateTaskState(
    taskId: TaskId,
    update: TaskStateUpdate,
    expectedVersion: number,
    event?: RunEvent,
  ): Promise<Result<{ readonly newVersion: number }, ConcurrencyConflictError | DomainError>> {
    for (const run of this.runs.values()) {
      const taskIndex = run.tasks.findIndex((t) => t.id === taskId);
      if (taskIndex !== -1) {
        const task = run.tasks[taskIndex];
        if (!task) {
          continue;
        }
        const currentVersion = task.version;

        // 1. Check terminal immutability and valid transition
        const transitionCheck = assertValidTaskTransition(task.status, update.status);
        if (!transitionCheck.ok) {
          return Promise.resolve(transitionCheck);
        }

        // 2. Check optimistic locking
        if (currentVersion !== expectedVersion) {
          return Promise.resolve(
            err(new ConcurrencyConflictError(taskId, expectedVersion, currentVersion)),
          );
        }

        // 3. Apply atomic update
        const newVersion = expectedVersion + 1;
        const updatedTask: Task = {
          ...task,
          status: update.status,
          workerId: update.workerId ?? task.workerId,
          worker: update.workerId ?? task.worker,
          version: newVersion,
          startedAt: update.startedAt ?? task.startedAt,
          completedAt: update.completedAt ?? task.completedAt,
          output: update.output ?? task.output,
          error: update.error ?? task.error,
        };
        run.tasks[taskIndex] = updatedTask;
        run.updatedAt = new Date().toISOString();

        if (event) {
          const list = this.events.get(event.runId) ?? [];
          list.push(structuredClone(event));
          this.events.set(event.runId, list);
          const outboxRecord = this.toOutboxRecord(event);
          this.outboxEvents.push(outboxRecord);
          if (this.outboxRepo) {
            void this.outboxRepo.insert([outboxRecord]);
          }
        }

        return Promise.resolve(ok({ newVersion }));
      }
    }

    return Promise.resolve(err(new TaskNotFoundError(taskId)));
  }

  acquireTaskLease(
    taskId: TaskId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>> {
    for (const run of this.runs.values()) {
      const task = run.tasks.find((t) => t.id === taskId);
      if (task) {
        if (task.version !== expectedVersion) {
          return Promise.resolve(
            err(
              new LeaseError(
                "CONCURRENCY_CONFLICT",
                `Version conflict acquiring lease for task '${taskId}': expected ${String(expectedVersion)}, actual ${String(task.version)}`,
                taskId,
                workerId,
              ),
            ),
          );
        }

        if (task.status !== "running") {
          return Promise.resolve(
            err(
              new LeaseError(
                "CONCURRENCY_CONFLICT",
                `Task '${taskId}' is in status '${task.status}', must be 'running' to acquire lease`,
                taskId,
                workerId,
              ),
            ),
          );
        }

        const now = new Date();
        const nowIso = now.toISOString();

        if (
          task.leaseId &&
          task.workerId &&
          task.workerId !== workerId &&
          task.leaseUntil &&
          task.leaseUntil > nowIso &&
          !task.leaseExpiredAt
        ) {
          return Promise.resolve(
            err(new LeaseOwnershipConflictError(taskId, task.workerId, workerId)),
          );
        }

        const newLeaseId = leaseId(`lease-${crypto.randomUUID()}`);
        const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
        const newVersion = expectedVersion + 1;

        task.leaseId = newLeaseId;
        task.workerId = workerId;
        task.worker = workerId;
        task.leaseUntil = leaseUntil;
        task.leaseExpiredAt = undefined;
        task.version = newVersion;
        run.updatedAt = nowIso;

        return Promise.resolve(
          ok({
            leaseId: newLeaseId,
            taskId,
            workerId,
            acquiredAt: nowIso,
            leaseUntil,
            version: newVersion,
          }),
        );
      }
    }

    return Promise.resolve(
      err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId)),
    );
  }

  renewTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>> {
    for (const run of this.runs.values()) {
      const task = run.tasks.find((t) => t.id === taskId);
      if (task) {
        if (task.version !== expectedVersion) {
          return Promise.resolve(
            err(
              new LeaseError(
                "CONCURRENCY_CONFLICT",
                `Version conflict renewing lease for task '${taskId}': expected ${String(expectedVersion)}, actual ${String(task.version)}`,
                taskId,
                workerId,
                leaseId,
              ),
            ),
          );
        }

        if (task.status !== "running") {
          return Promise.resolve(
            err(
              new LeaseError(
                "CONCURRENCY_CONFLICT",
                `Task '${taskId}' is in status '${task.status}', must be 'running' to renew lease`,
                taskId,
                workerId,
                leaseId,
              ),
            ),
          );
        }

        if (!task.leaseId || task.leaseId !== leaseId) {
          return Promise.resolve(
            err(
              new StaleLeaseError(
                taskId,
                leaseId,
                task.leaseId ? (task.leaseId as unknown as LeaseId) : undefined,
              ),
            ),
          );
        }

        if (task.workerId && task.workerId !== workerId) {
          return Promise.resolve(
            err(new LeaseOwnershipConflictError(taskId, task.workerId, workerId)),
          );
        }

        const now = new Date();
        const nowIso = now.toISOString();

        if (task.leaseExpiredAt || (task.leaseUntil && task.leaseUntil < nowIso)) {
          return Promise.resolve(err(new LeaseExpiredError(taskId, leaseId, workerId)));
        }

        const newLeaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
        const newVersion = expectedVersion + 1;

        task.leaseUntil = newLeaseUntil;
        task.version = newVersion;
        run.updatedAt = nowIso;

        return Promise.resolve(
          ok({
            leaseId,
            taskId,
            workerId,
            acquiredAt: task.startedAt ?? nowIso,
            leaseUntil: newLeaseUntil,
            version: newVersion,
          }),
        );
      }
    }

    return Promise.resolve(
      err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId, leaseId)),
    );
  }

  releaseTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    expectedVersion: number,
  ): Promise<Result<void, LeaseError>> {
    for (const run of this.runs.values()) {
      const task = run.tasks.find((t) => t.id === taskId);
      if (task) {
        if (task.version !== expectedVersion) {
          return Promise.resolve(
            err(
              new LeaseError(
                "CONCURRENCY_CONFLICT",
                `Version conflict releasing lease for task '${taskId}': expected ${String(expectedVersion)}, actual ${String(task.version)}`,
                taskId,
                workerId,
                leaseId,
              ),
            ),
          );
        }

        if (task.leaseId && task.leaseId !== leaseId) {
          return Promise.resolve(
            err(
              new StaleLeaseError(
                taskId,
                leaseId,
                task.leaseId ? (task.leaseId as unknown as LeaseId) : undefined,
              ),
            ),
          );
        }

        if (task.workerId && task.workerId !== workerId) {
          return Promise.resolve(
            err(new LeaseOwnershipConflictError(taskId, task.workerId, workerId)),
          );
        }

        const newVersion = expectedVersion + 1;
        task.leaseId = undefined;
        task.leaseUntil = undefined;
        task.version = newVersion;
        run.updatedAt = new Date().toISOString();

        return Promise.resolve(ok(undefined));
      }
    }

    return Promise.resolve(
      err(new LeaseError("TASK_NOT_FOUND", `Task '${taskId}' not found`, taskId, workerId, leaseId)),
    );
  }

  getExpiredTaskLeases(cutoff: Date, limit = 50): Promise<Task[]> {
    const cutoffIso = cutoff.toISOString();
    const candidates: Task[] = [];

    for (const run of this.runs.values()) {
      for (const task of run.tasks) {
        if (
          task.status === "running" &&
          task.leaseUntil &&
          task.leaseUntil < cutoffIso &&
          !task.leaseExpiredAt
        ) {
          const candidate = structuredClone(task);
          candidate.runId = run.id;
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => (a.leaseUntil ?? "").localeCompare(b.leaseUntil ?? ""));
    return Promise.resolve(candidates.slice(0, limit));
  }

  markTaskLeaseExpired(
    taskId: TaskId,
    expectedVersion: number,
    expiredAt: Date,
    event?: RunEvent,
  ): Promise<boolean> {
    const expiredAtIso = expiredAt.toISOString();

    for (const run of this.runs.values()) {
      const taskIndex = run.tasks.findIndex((t) => t.id === taskId);
      if (taskIndex !== -1) {
        const task = run.tasks[taskIndex];
        if (!task) continue;

        if (
          task.version === expectedVersion &&
          task.status === "running" &&
          task.leaseUntil &&
          task.leaseUntil < expiredAtIso &&
          !task.leaseExpiredAt
        ) {
          task.leaseExpiredAt = expiredAtIso;
          task.version = expectedVersion + 1;
          run.updatedAt = expiredAtIso;

          if (event) {
            const list = this.events.get(event.runId) ?? [];
            list.push(structuredClone(event));
            this.events.set(event.runId, list);
            const outboxRecord = this.toOutboxRecord(event);
            this.outboxEvents.push(outboxRecord);
            if (this.outboxRepo) {
              void this.outboxRepo.insert([outboxRecord]);
            }
          }

          return Promise.resolve(true);
        }

        return Promise.resolve(false);
      }
    }

    return Promise.resolve(false);
  }

  private toOutboxRecord(event: RunEvent): OutboxRecord {
    const envelope = toEventEnvelope(event, {
      source: "aegis.api",
      correlationId: event.runId,
    });
    return {
      id: outboxEventId(event.id),
      aggregateId: envelope.aggregateId,
      aggregateType: envelope.aggregateType,
      eventType: envelope.type,
      payload: envelope,
      status: "pending",
      attemptCount: 0,
      createdAt: event.timestamp,
    };
  }

  getOutboxEvents(): OutboxRecord[] {
    return structuredClone(this.outboxEvents);
  }

  findOrphanedTasks(limit = 50): Promise<Task[]> {
    const candidates: Task[] = [];

    for (const run of this.runs.values()) {
      for (const task of run.tasks) {
        if (task.status === "running" && task.leaseExpiredAt) {
          const candidate = structuredClone(task);
          candidate.runId = run.id;
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => (a.leaseExpiredAt ?? "").localeCompare(b.leaseExpiredAt ?? ""));
    return Promise.resolve(candidates.slice(0, limit));
  }

  reassignTask(
    params: ReassignTaskParams,
    outboxRecords?: readonly CreateOutboxRecord[],
  ): Promise<Result<Task, RecoveryError>> {
    const { taskId, expectedVersion, newWorkerId, newLeaseId, leaseDurationMs, event } = params;
    const now = new Date();
    const nowIso = now.toISOString();
    const newLeaseUntilIso = new Date(now.getTime() + leaseDurationMs).toISOString();

    for (const run of this.runs.values()) {
      const taskIndex = run.tasks.findIndex((t) => t.id === taskId);
      if (taskIndex !== -1) {
        const task = run.tasks[taskIndex];
        if (!task) continue;

        if (task.status !== "running" || !task.leaseExpiredAt) {
          return Promise.resolve(
            err(
              new TaskNotRecoverableError(
                taskId,
                `Task is in state '${task.status}' and leaseExpiredAt is ${String(task.leaseExpiredAt)}`,
              ),
            ),
          );
        }

        if (task.version !== expectedVersion) {
          return Promise.resolve(
            err(new RecoveryConflictError(taskId, expectedVersion, task.version)),
          );
        }

        task.worker = newWorkerId;
        task.workerId = newWorkerId;
        task.leaseId = leaseId(newLeaseId);
        task.leaseUntil = newLeaseUntilIso;
        task.leaseExpiredAt = undefined;
        task.attemptCount += 1;
        task.version = expectedVersion + 1;
        run.updatedAt = nowIso;

        if (event) {
          const list = this.events.get(event.runId) ?? [];
          list.push(structuredClone(event));
          this.events.set(event.runId, list);
        }

        if (outboxRecords && outboxRecords.length > 0) {
          for (const r of outboxRecords) {
            const rec: OutboxRecord = {
              id: r.id ? outboxEventId(r.id) : outboxEventId(r.payload.id || crypto.randomUUID()),
              aggregateId: r.aggregateId,
              aggregateType: r.aggregateType,
              eventType: r.eventType,
              topic: r.topic ?? undefined,
              payload: r.payload,
              status: r.status ?? "pending",
              attemptCount: r.attemptCount ?? 0,
              createdAt: r.createdAt ?? nowIso,
            };
            this.outboxEvents.push(rec);
          }
          if (this.outboxRepo) {
            void this.outboxRepo.insert(outboxRecords);
          }
        }

        const cloned = structuredClone(task);
        cloned.runId = run.id;
        return Promise.resolve(ok(cloned));
      }
    }

    return Promise.resolve(
      err(new TaskNotRecoverableError(taskId, "Task does not exist")),
    );
  }

  failExhaustedTask(
    params: FailExhaustedTaskParams,
    outboxRecords?: readonly CreateOutboxRecord[],
  ): Promise<Result<Task, RecoveryError>> {
    const { taskId, expectedVersion, reason, event } = params;
    const now = new Date();
    const nowIso = now.toISOString();

    for (const run of this.runs.values()) {
      const taskIndex = run.tasks.findIndex((t) => t.id === taskId);
      if (taskIndex !== -1) {
        const task = run.tasks[taskIndex];
        if (!task) continue;

        if (task.status !== "running" || !task.leaseExpiredAt) {
          return Promise.resolve(
            err(
              new TaskNotRecoverableError(
                taskId,
                `Task is in state '${task.status}' and leaseExpiredAt is ${String(task.leaseExpiredAt)}`,
              ),
            ),
          );
        }

        if (task.version !== expectedVersion) {
          return Promise.resolve(
            err(new RecoveryConflictError(taskId, expectedVersion, task.version)),
          );
        }

        task.status = "failed";
        task.error = reason;
        task.completedAt = nowIso;
        task.version = expectedVersion + 1;
        run.updatedAt = nowIso;

        if (event) {
          const list = this.events.get(event.runId) ?? [];
          list.push(structuredClone(event));
          this.events.set(event.runId, list);
        }

        if (outboxRecords && outboxRecords.length > 0) {
          for (const r of outboxRecords) {
            const rec: OutboxRecord = {
              id: r.id ? outboxEventId(r.id) : outboxEventId(r.payload.id || crypto.randomUUID()),
              aggregateId: r.aggregateId,
              aggregateType: r.aggregateType,
              eventType: r.eventType,
              topic: r.topic ?? undefined,
              payload: r.payload,
              status: r.status ?? "pending",
              attemptCount: r.attemptCount ?? 0,
              createdAt: r.createdAt ?? nowIso,
            };
            this.outboxEvents.push(rec);
          }
          if (this.outboxRepo) {
            void this.outboxRepo.insert(outboxRecords);
          }
        }

        const cloned = structuredClone(task);
        cloned.runId = run.id;
        return Promise.resolve(ok(cloned));
      }
    }

    return Promise.resolve(
      err(new TaskNotRecoverableError(taskId, "Task does not exist")),
    );
  }
}
