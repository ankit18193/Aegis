/**
 * AuditSubscriber — Application-level event subscriber for execution audit logging.
 * Pure observer subscribing to Aegis lifecycle events to produce structured audit records.
 *
 * Invariant (Lock 5): Handlers strictly perform read-only observation and logging.
 * Zero workflow state mutations, zero worker task scheduling.
 */

import type {
  ConsumerRecordMetadata,
  EventConsumerErrorContract,
  EventEnvelope,
  EventType,
  IEventSubscriber,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

export interface AuditRecord {
  readonly eventId: string;
  readonly runId: string;
  readonly type: EventType;
  readonly timestamp: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly taskId?: string | undefined;
  readonly taskName?: string | undefined;
  readonly message?: string | undefined;
}

export const LIFECYCLE_EVENT_TYPES: readonly EventType[] = [
  "run_created",
  "workflow_started",
  "task_scheduled",
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "tool_invoked",
  "run_completed",
  "run_failed",
  "run_cancelled",
] as const;

export class AuditSubscriber {
  private readonly records: AuditRecord[] = [];
  private readonly boundHandler: (
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ) => Promise<Result<void, EventConsumerErrorContract>>;

  constructor(
    private readonly subscriber: IEventSubscriber,
    private readonly logger?: Logger | undefined,
  ) {
    this.boundHandler = this.handleEvent.bind(this);
  }

  /**
   * Registers audit observer handlers for all lifecycle event types.
   */
  public register(): void {
    for (const type of LIFECYCLE_EVENT_TYPES) {
      this.subscriber.subscribe(type, this.boundHandler);
    }
  }

  /**
   * Unregisters all audit observer handlers from the subscriber.
   */
  public unregister(): void {
    for (const type of LIFECYCLE_EVENT_TYPES) {
      this.subscriber.unsubscribe(type, this.boundHandler);
    }
  }

  /**
   * Handles incoming event envelope, captures structured audit record, and logs.
   */
  public handleEvent(
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ): Promise<Result<void, EventConsumerErrorContract>> {
    const record: AuditRecord = {
      eventId: envelope.id,
      runId: envelope.aggregateId,
      type: envelope.type,
      timestamp: envelope.time,
      topic: metadata.topic,
      partition: metadata.partition,
      offset: metadata.offset,
      taskId: envelope.data.taskId,
      taskName: envelope.data.taskName,
      message: envelope.data.message,
    };

    this.records.push(record);

    this.logger?.info(`[AUDIT] Execution event ${envelope.type} observed`, {
      eventId: record.eventId,
      runId: record.runId,
      type: record.type,
      taskId: record.taskId,
      offset: record.offset,
      partition: record.partition,
    });

    return Promise.resolve(ok(undefined));
  }

  /**
   * Retrieves recorded audit entries (useful for observation assertions and tests).
   */
  public getRecords(): readonly AuditRecord[] {
    return [...this.records];
  }

  /**
   * Retrieves audit records for a specific execution run.
   */
  public getRecordsByRunId(runId: string): readonly AuditRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  /**
   * Clears in-memory audit records.
   */
  public clear(): void {
    this.records.length = 0;
  }
}
