import type {
  AssignmentErrorContract,
} from "@aegis/contracts";
import {
  createAssignmentError,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Consumer, EachMessagePayload } from "kafkajs";

import type { TaskAssignmentHandler } from "../assignment/handler.js";
import type { TaskExecutionService } from "../execution/executionService.js";

import { deserializeAssignmentEnvelope } from "./serialization.js";

export interface WorkerTaskConsumerOptions {
  readonly consumer: Consumer;
  readonly topic: string;
  readonly handler: TaskAssignmentHandler;
  readonly executionService?: TaskExecutionService | undefined;
  readonly logger?: Logger | undefined;
  readonly fromBeginning?: boolean | undefined;
  readonly drainTimeoutMs?: number | undefined;
}

/**
 * WorkerTaskConsumer — Consumes task assignments from Kafka topic.
 *
 * Implements Phase 11C pipeline semantics:
 * 1. Deserializes TaskAssignmentEnvelope from Kafka message
 * 2. Quarantines poison pills (empty or invalid envelopes) with offset commit
 * 3. Dispatches payload to TaskAssignmentHandler
 * 4. Suppresses duplicates with offset commit
 * 5. Targeted mismatch -> DOES NOT COMMIT OFFSET to prevent losing work in shared group
 * 6. Accepted assignment -> Executes via TaskExecutionService -> publishes result to aegis.tasks.results
 * 7. Commits offset strictly AFTER result publication succeeds (Result-Before-Offset-Commit)
 * 8. Uncommitted offsets on publication or infrastructure failure
 * 9. Graceful in-flight task draining upon shutdown
 */
export class WorkerTaskConsumer {
  private readonly consumer: Consumer;
  private readonly topic: string;
  private readonly handler: TaskAssignmentHandler;
  private readonly executionService?: TaskExecutionService | undefined;
  private readonly logger?: Logger | undefined;
  private readonly fromBeginning: boolean;
  private readonly drainTimeoutMs: number;

  private _isRunning = false;
  private _isStarting = false;
  private _isStopping = false;
  private inFlightMessages = 0;

  constructor(options: WorkerTaskConsumerOptions) {
    this.consumer = options.consumer;
    this.topic = options.topic;
    this.handler = options.handler;
    this.executionService = options.executionService;
    this.logger = options.logger;
    this.fromBeginning = options.fromBeginning ?? false;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;

    this.consumer.on(this.consumer.events.REBALANCING, () => {
      this.logger?.info("Worker Kafka consumer rebalance initiated", {
        topic: this.topic,
      });
    });

    this.consumer.on(this.consumer.events.GROUP_JOIN, (e) => {
      this.logger?.info("Worker Kafka consumer joined consumer group", {
        topic: this.topic,
        memberId: e.payload.memberId,
      });
    });

    this.consumer.on(this.consumer.events.CRASH, (e) => {
      this.logger?.error("Worker Kafka consumer crashed", {
        topic: this.topic,
        error:
          e.payload.error instanceof Error
            ? e.payload.error.message
            : String(e.payload.error),
      });
    });
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public get activeMessageCount(): number {
    return this.inFlightMessages;
  }

  /**
   * Starts the Kafka consumer, connects, subscribes to topic, and starts listening.
   */
  public async start(): Promise<Result<void, AssignmentErrorContract>> {
    if (this._isRunning || this._isStarting) {
      return ok(undefined);
    }

    this._isStarting = true;

    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: this.topic,
        fromBeginning: this.fromBeginning,
      });

      await this.consumer.run({
        autoCommit: false,
        eachMessage: async (payload: EachMessagePayload) => {
          await this.processMessage(payload);
        },
      });

      this._isRunning = true;
      this._isStarting = false;
      this.logger?.info("WorkerTaskConsumer started successfully", {
        topic: this.topic,
      });
      return ok(undefined);
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
      const wrapped = createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        `Failed to start WorkerTaskConsumer: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
      this.logger?.error("Failed to start WorkerTaskConsumer", {
        error: wrapped.message,
      });
      return err(wrapped);
    }
  }

  /**
   * Gracefully stops the Kafka consumer and disconnects.
   * Drains in-flight messages up to drainTimeoutMs before disconnecting.
   */
  public async stop(): Promise<Result<void, AssignmentErrorContract>> {
    if (!this._isRunning && !this._isStarting) {
      return ok(undefined);
    }

    this._isStopping = true;

    try {
      // Graceful drain: first drain execution service if attached
      if (this.executionService) {
        await this.executionService.drain(this.drainTimeoutMs);
      }

      // Graceful drain: wait for in-flight message processing to finish
      const drainStart = Date.now();
      while (this.inFlightMessages > 0 && Date.now() - drainStart < this.drainTimeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await this.consumer.stop();
      await this.consumer.disconnect();
      this._isRunning = false;
      this._isStarting = false;
      this._isStopping = false;
      this.logger?.info("WorkerTaskConsumer stopped cleanly", {
        topic: this.topic,
      });
      return ok(undefined);
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
      this._isStopping = false;
      const wrapped = createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        `Error stopping WorkerTaskConsumer: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
      this.logger?.error("Error stopping WorkerTaskConsumer", {
        error: wrapped.message,
      });
      return err(wrapped);
    }
  }

  public getExecutionService(): TaskExecutionService | undefined {
    return this.executionService;
  }

  /**
   * Processes a single incoming Kafka message according to the Phase 11C pipeline:
   * 1. Check for empty payload -> quarantine & commit
   * 2. Deserialization -> quarantine & commit on malformed envelope
   * 3. TaskAssignmentHandler:
   *    - ignored_not_targeted -> DO NOT COMMIT (prevents work loss in shared consumer group)
   *    - rejected -> commit offset (unblocks partition)
   *    - accepted -> execute via TaskExecutionService -> publish result -> commit offset
   * 4. Suppress duplicates -> commit
   * 5. Unhandled error or publication failure -> leave offset uncommitted
   *
   * @returns true if offset was committed, false if uncommitted
   */
  public async processMessage(payload: EachMessagePayload): Promise<boolean> {
    this.inFlightMessages++;
    try {
      return await this.handleMessageInternal(payload);
    } finally {
      this.inFlightMessages--;
    }
  }

  private async handleMessageInternal(payload: EachMessagePayload): Promise<boolean> {
    const { topic, partition, message } = payload;

    if (!message.value) {
      this.logger?.warn(
        "Received empty Kafka message; committing offset to avoid partition head-of-line blocking",
        { topic, partition, offset: message.offset },
      );
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    // 1. Deserialization
    const deserResult = deserializeAssignmentEnvelope(message.value);
    if (!deserResult.ok) {
      this.logger?.error(
        "Poison pill detected: message failed deserialization. Committing offset to avoid blocking partition.",
        {
          topic,
          partition,
          offset: message.offset,
          error: deserResult.error.message,
        },
      );
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    const envelope = deserResult.value;

    // 2. Handling with safe exception containment
    let handlingResult;
    try {
      handlingResult = this.handler.handleAssignment(envelope.data);
    } catch (unhandledException) {
      this.logger?.error(
        "TaskAssignmentHandler threw an unhandled exception. Offset will NOT be committed.",
        {
          topic,
          partition,
          offset: message.offset,
          assignmentId: envelope.data.assignmentId,
          error:
            unhandledException instanceof Error
              ? unhandledException.message
              : String(unhandledException),
        },
      );
      return false;
    }

    if (handlingResult.ok) {
      const status = handlingResult.value.status;

      // Phase 11C Rule: Do NOT commit if not targeted to this worker!
      if (status === "ignored_not_targeted") {
        this.logger?.warn(
          "Task assignment targeted to different worker. Offset will NOT be committed to prevent work loss in shared group.",
          {
            topic,
            partition,
            offset: message.offset,
            assignmentId: envelope.data.assignmentId,
            targetWorkerId: envelope.data.workerId,
          },
        );
        return false;
      }

      // If rejected due to capabilities mismatch, commit to unblock partition
      if (status === "rejected") {
        this.logger?.warn("Task assignment rejected due to capabilities mismatch; committing offset", {
          topic,
          partition,
          offset: message.offset,
          assignmentId: envelope.data.assignmentId,
          reason: handlingResult.value.reason,
        });
        await this.commitOffset(topic, partition, message.offset);
        return true;
      }

      // status === "accepted"
      if (this.executionService) {
        this.logger?.info("Task assignment accepted; executing and reporting result", {
          topic,
          partition,
          offset: message.offset,
          assignmentId: envelope.data.assignmentId,
          taskId: envelope.data.taskId,
        });

        const execOutcome = await this.executionService.executeAndReport(
          envelope.data,
          {
            correlationId: envelope.correlationId,
            causationId: envelope.id,
          },
        );

        if (!execOutcome.ok) {
          this.logger?.error("Task result publication failed. Assignment offset will NOT be committed.", {
            topic,
            partition,
            offset: message.offset,
            assignmentId: envelope.data.assignmentId,
            taskId: envelope.data.taskId,
            error: execOutcome.error.message,
          });
          return false;
        }

        this.logger?.info("Task execution completed and result published; committing assignment offset", {
          topic,
          partition,
          offset: message.offset,
          assignmentId: envelope.data.assignmentId,
          taskId: envelope.data.taskId,
          status: execOutcome.value.status,
        });
        await this.commitOffset(topic, partition, message.offset);
        return true;
      }

      // Backward compatibility when no executionService is attached
      this.logger?.debug("Task assignment accepted without executionService; committing offset", {
        topic,
        partition,
        offset: message.offset,
        assignmentId: envelope.data.assignmentId,
      });
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    // 3. Error branch: duplicate vs unexpected failure
    if (handlingResult.error.code === "DUPLICATE_ASSIGNMENT") {
      this.logger?.info("Duplicate assignment suppressed; committing offset", {
        topic,
        partition,
        offset: message.offset,
        assignmentId: envelope.data.assignmentId,
      });
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    // Unhandled / unexpected handler failure
    this.logger?.error("Task assignment handling failed. Offset will NOT be committed.", {
      topic,
      partition,
      offset: message.offset,
      assignmentId: envelope.data.assignmentId,
      error: handlingResult.error.message,
    });
    return false;
  }

  /**
   * Commits the next offset for a given partition.
   */
  public async commitOffset(
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    try {
      const nextOffset = (BigInt(offset) + 1n).toString();
      await this.consumer.commitOffsets([
        {
          topic,
          partition,
          offset: nextOffset,
        },
      ]);
    } catch (commitError) {
      this.logger?.error("Failed to commit Kafka offset", {
        topic,
        partition,
        offset,
        error:
          commitError instanceof Error
            ? commitError.message
            : String(commitError),
      });
      throw commitError;
    }
  }
}
