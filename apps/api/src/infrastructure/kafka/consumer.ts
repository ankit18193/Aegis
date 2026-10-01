/**
 * Production-ready Kafka Event Consumer.
 * Implements canonical IEventSubscriber contract.
 *
 * Encapsulates KafkaJS Consumer details:
 * - Independent subscription registration before startup
 * - In-process best-effort deduplication
 * - Manual offset commits on handler success
 * - Poison pill quarantine with offset commit to prevent partition blocking
 * - Uncommitted offsets on handler failure to preserve at-least-once semantics
 */

import type {
  ConsumerRecordMetadata,
  EventConsumerErrorContract,
  EventHandler,
  EventType,
  IEventDeduplicator,
  IEventSubscriber,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Consumer, EachMessagePayload } from "kafkajs";

import { deserializeEnvelope } from "../../events/envelope.js";
import {
  ConsumerNotConnectedError,
  DispatchError,
  EventConsumerError,
  SubscriptionError,
} from "../../events/errors.js";

import { EventDispatcher } from "./dispatcher.js";

export function translateConsumerError(error: unknown): EventConsumerError {
  if (error instanceof EventConsumerError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("not connected") || lowerMsg.includes("disconnected")) {
    return new ConsumerNotConnectedError(message, error);
  }
  if (lowerMsg.includes("subscribe") || lowerMsg.includes("subscription")) {
    return new SubscriptionError(message, error);
  }
  return new DispatchError(message, error);
}

export interface KafkaEventConsumerOptions {
  readonly consumer: Consumer;
  readonly topic: string;
  readonly deduplicator?: IEventDeduplicator | undefined;
  readonly logger?: Logger | undefined;
  readonly fromBeginning?: boolean | undefined;
}

export class KafkaEventConsumer implements IEventSubscriber {
  private readonly consumer: Consumer;
  private readonly topic: string;
  private readonly deduplicator?: IEventDeduplicator | undefined;
  private readonly logger?: Logger | undefined;
  private readonly fromBeginning: boolean;
  private readonly dispatcher = new EventDispatcher();

  private _isRunning = false;
  private _isStarting = false;

  constructor(options: KafkaEventConsumerOptions) {
    this.consumer = options.consumer;
    this.topic = options.topic;
    this.deduplicator = options.deduplicator;
    this.logger = options.logger;
    this.fromBeginning = options.fromBeginning ?? false;

    this.consumer.on(this.consumer.events.REBALANCING, () => {
      this.logger?.info("Kafka consumer rebalance initiated", { topic: this.topic });
    });
    this.consumer.on(this.consumer.events.GROUP_JOIN, (e) => {
      this.logger?.info("Kafka consumer joined consumer group", {
        topic: this.topic,
        memberId: e.payload.memberId,
      });
    });
    this.consumer.on(this.consumer.events.CRASH, (e) => {
      this.logger?.error("Kafka consumer crashed", {
        topic: this.topic,
        error: e.payload.error instanceof Error ? e.payload.error.message : String(e.payload.error),
      });
    });
  }

  /**
   * Registers a subscription handler for a given event type or wildcard '*'.
   * Subscriptions can be registered independently before start().
   */
  public subscribe(type: EventType | "*", handler: EventHandler): void {
    this.dispatcher.subscribe(type, handler);
  }

  /**
   * Unregisters a subscription handler.
   */
  public unsubscribe(type: EventType | "*", handler: EventHandler): void {
    this.dispatcher.unsubscribe(type, handler);
  }

  /**
   * Starts the Kafka consumer, connects, subscribes to topic, and starts listening.
   */
  public async start(): Promise<Result<void, EventConsumerErrorContract>> {
    if (this._isRunning) {
      return ok(undefined);
    }
    if (this._isStarting) {
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
      this.logger?.info("KafkaEventConsumer started successfully", {
        topic: this.topic,
        subscribedTypes: this.dispatcher.getSubscribedTypes(),
      });
      return ok(undefined);
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
      const wrapped = translateConsumerError(error);
      this.logger?.error("Failed to start KafkaEventConsumer", { error: wrapped });
      return err(wrapped);
    }
  }

  /**
   * Stops the Kafka consumer and disconnects cleanly.
   */
  public async stop(): Promise<Result<void, EventConsumerErrorContract>> {
    if (!this._isRunning && !this._isStarting) {
      return ok(undefined);
    }

    try {
      await this.consumer.stop();
      await this.consumer.disconnect();
      this._isRunning = false;
      this._isStarting = false;
      this.logger?.info("KafkaEventConsumer stopped cleanly", { topic: this.topic });
      return ok(undefined);
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
      const wrapped = translateConsumerError(error);
      this.logger?.error("Error stopping KafkaEventConsumer", { error: wrapped });
      return err(wrapped);
    }
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Processes a single incoming Kafka message according to the 10B processing pipeline:
   * 1. Deserialization (quarantines poison pill and commits offset if invalid)
   * 2. Deduplication (suppresses duplicate and commits offset)
   * 3. Dispatch to handlers
   * 4. Offset commit strictly on handler success
   *
   * @returns true if the offset was committed, false if uncommitted
   */
  public async processMessage(payload: EachMessagePayload): Promise<boolean> {
    const { topic, partition, message } = payload;
    const rawValue = message.value?.toString("utf8");

    if (!rawValue) {
      this.logger?.warn(
        "Received empty Kafka message; committing offset to avoid partition head-of-line blocking",
        { topic, partition, offset: message.offset },
      );
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    // Step 1: Explicit deserialization boundary
    const deserResult = deserializeEnvelope(rawValue);
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

    // Step 2: In-process duplicate suppression
    if (this.deduplicator?.isDuplicate(envelope.id)) {
      this.logger?.info("Duplicate event suppressed by in-memory deduplicator", {
        eventId: envelope.id,
        type: envelope.type,
        topic,
        partition,
        offset: message.offset,
      });
      await this.commitOffset(topic, partition, message.offset);
      return true;
    }

    // Step 3: Dispatch to registered handlers
    const metadata: ConsumerRecordMetadata = {
      topic,
      partition,
      offset: message.offset,
      timestamp: message.timestamp,
      key: message.key ? message.key.toString("utf8") : undefined,
    };

    const dispatchResult = await this.dispatcher.dispatch(envelope, metadata);

    if (!dispatchResult.ok) {
      this.logger?.error("Event handler execution failed. Offset will NOT be committed.", {
        eventId: envelope.id,
        type: envelope.type,
        topic,
        partition,
        offset: message.offset,
        error: dispatchResult.error,
      });
      // Do NOT commit offset: Kafka consumer group redelivery will re-process on restart/rebalance
      return false;
    }

    // Step 4: Commit offset strictly on success
    await this.commitOffset(topic, partition, message.offset);
    return true;
  }

  /**
   * Commits the next offset for a given partition.
   */
  private async commitOffset(topic: string, partition: number, offset: string): Promise<void> {
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
        error: commitError instanceof Error ? commitError.message : String(commitError),
      });
      throw commitError;
    }
  }

  /**
   * Access the internal dispatcher for inspection and test verification.
   */
  public getDispatcher(): EventDispatcher {
    return this.dispatcher;
  }
}
