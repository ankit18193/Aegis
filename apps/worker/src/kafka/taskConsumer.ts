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

import { deserializeAssignmentEnvelope } from "./serialization.js";

export interface WorkerTaskConsumerOptions {
  readonly consumer: Consumer;
  readonly topic: string;
  readonly handler: TaskAssignmentHandler;
  readonly logger?: Logger | undefined;
  readonly fromBeginning?: boolean | undefined;
}

/**
 * WorkerTaskConsumer — Consumes task assignments from Kafka topic.
 *
 * Implements Phase 11B pipeline semantics:
 * 1. Deserializes TaskAssignmentEnvelope from Kafka message
 * 2. Quarantines poison pills (empty or invalid envelopes) with offset commit
 * 3. Dispatches payload to TaskAssignmentHandler
 * 4. Suppresses duplicates with offset commit
 * 5. Handles non-targeted assignments with offset commit (does not block partition)
 * 6. Commits offset strictly upon successful message processing
 * 7. Uncommitted offsets on unexpected handler errors
 */
export class WorkerTaskConsumer {
  private readonly consumer: Consumer;
  private readonly topic: string;
  private readonly handler: TaskAssignmentHandler;
  private readonly logger?: Logger | undefined;
  private readonly fromBeginning: boolean;

  private _isRunning = false;
  private _isStarting = false;

  constructor(options: WorkerTaskConsumerOptions) {
    this.consumer = options.consumer;
    this.topic = options.topic;
    this.handler = options.handler;
    this.logger = options.logger;
    this.fromBeginning = options.fromBeginning ?? false;

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
   */
  public async stop(): Promise<Result<void, AssignmentErrorContract>> {
    if (!this._isRunning && !this._isStarting) {
      return ok(undefined);
    }

    try {
      await this.consumer.stop();
      await this.consumer.disconnect();
      this._isRunning = false;
      this._isStarting = false;
      this.logger?.info("WorkerTaskConsumer stopped cleanly", {
        topic: this.topic,
      });
      return ok(undefined);
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
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

  /**
   * Processes a single incoming Kafka message according to the Phase 11B pipeline:
   * 1. Check for empty payload -> quarantine & commit
   * 2. Deserialization -> quarantine & commit on malformed envelope
   * 3. TaskAssignmentHandler -> commit on accepted, rejected, or ignored_not_targeted
   * 4. Suppress duplicates -> commit
   * 5. Unhandled error -> leave offset uncommitted
   *
   * @returns true if offset was committed, false if uncommitted
   */
  public async processMessage(payload: EachMessagePayload): Promise<boolean> {
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

    // 2. Handling
    const handlingResult = this.handler.handleAssignment(envelope.data);

    if (handlingResult.ok) {
      this.logger?.debug("Task assignment processed successfully; committing offset", {
        topic,
        partition,
        offset: message.offset,
        assignmentId: envelope.data.assignmentId,
        status: handlingResult.value.status,
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
