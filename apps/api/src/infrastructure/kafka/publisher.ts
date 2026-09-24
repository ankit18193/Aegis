/**
 * Kafka Event Publisher.
 *
 * Implements canonical IEventPublisher contract over KafkaJS Producer.
 * Enforces per-run FIFO partitioning (key = aggregateId / runId),
 * CloudEvents header mapping, explicit JSON serialization boundary,
 * and typed error translation.
 */

import type {
  EventEnvelope,
  EventPublishErrorContract,
  EventPublishResult,
  IEventPublisher,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Producer, RecordMetadata } from "kafkajs";

import { serializeEnvelope } from "../../events/envelope.js";
import {
  EventPublishError,
  KafkaBrokerUnavailableError,
  KafkaConnectionFailedError,
  KafkaNotConnectedError,
  KafkaPublishTimeoutError,
} from "../../events/errors.js";

export interface KafkaEventPublisherOptions {
  readonly producer: Producer;
  readonly topic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Translates arbitrary KafkaJS / network errors into canonical EventPublishError instances.
 */
export function translateKafkaError(error: unknown): EventPublishError {
  if (error instanceof EventPublishError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes("not connected") || lowerMsg.includes("disconnected")) {
    return new KafkaNotConnectedError(message, error);
  }
  if (lowerMsg.includes("timeout") || lowerMsg.includes("timed out")) {
    return new KafkaPublishTimeoutError(message, error);
  }
  if (
    lowerMsg.includes("broker") ||
    lowerMsg.includes("leader not available") ||
    lowerMsg.includes("econnrefused")
  ) {
    return new KafkaBrokerUnavailableError(message, error);
  }
  return new KafkaConnectionFailedError(message, error);
}

/**
 * Builds CloudEvents compliant headers for a given EventEnvelope.
 */
function buildCloudEventsHeaders(envelope: EventEnvelope): Record<string, string> {
  const headers: Record<string, string> = {
    ce_specversion: envelope.specVersion,
    ce_id: envelope.id,
    ce_type: envelope.type,
    ce_source: envelope.source,
    ce_time: envelope.time,
    ce_subject: envelope.aggregateId,
    ce_correlationid: envelope.correlationId,
  };
  if (envelope.causationId) {
    headers["ce_causationid"] = envelope.causationId;
  }
  return headers;
}

export class KafkaEventPublisher implements IEventPublisher {
  private readonly producer: Producer;
  private readonly topic: string;
  private readonly logger?: Logger | undefined;
  private _connected = false;

  constructor(options: KafkaEventPublisherOptions) {
    this.producer = options.producer;
    this.topic = options.topic ?? "aegis.events";
    this.logger = options.logger;
  }

  get connected(): boolean {
    return this._connected;
  }

  get targetTopic(): string {
    return this.topic;
  }

  /**
   * Connects the underlying Kafka producer.
   */
  async connect(): Promise<Result<void, EventPublishErrorContract>> {
    if (this._connected) {
      return ok(undefined);
    }
    try {
      await this.producer.connect();
      this._connected = true;
      this.logger?.info("Kafka producer connected successfully", { topic: this.topic });
      return ok(undefined);
    } catch (error) {
      const wrapped = translateKafkaError(error);
      this.logger?.error("Failed to connect Kafka producer", { error: wrapped.message });
      return err(wrapped);
    }
  }

  /**
   * Disconnects the underlying Kafka producer.
   */
  async disconnect(): Promise<Result<void, EventPublishErrorContract>> {
    if (!this._connected) {
      return ok(undefined);
    }
    try {
      await this.producer.disconnect();
      this._connected = false;
      this.logger?.info("Kafka producer disconnected cleanly");
      return ok(undefined);
    } catch (error) {
      const wrapped = translateKafkaError(error);
      this.logger?.error("Error during Kafka producer disconnect", { error: wrapped.message });
      return err(wrapped);
    }
  }

  /**
   * Publishes a single canonical EventEnvelope to Kafka.
   * Partition key is strictly envelope.aggregateId (runId) for FIFO ordering.
   */
  async publish(
    envelope: EventEnvelope,
  ): Promise<Result<EventPublishResult, EventPublishErrorContract>> {
    if (!this._connected) {
      return err(
        new KafkaNotConnectedError(
          "Kafka producer is not connected. Call connect() before publishing.",
        ),
      );
    }

    const serResult = serializeEnvelope(envelope);
    if (!serResult.ok) {
      return serResult;
    }

    const headers = buildCloudEventsHeaders(envelope);

    try {
      const recordMetas: RecordMetadata[] = await this.producer.send({
        topic: this.topic,
        messages: [
          {
            key: envelope.aggregateId,
            value: serResult.value,
            headers,
          },
        ],
      });

      const meta = recordMetas[0];
      return ok({
        success: true,
        topic: meta?.topicName ?? this.topic,
        partition: meta?.partition,
        offset: meta?.offset,
        messageId: undefined, // KafkaJS provides partition/offset, no broker messageId
      });
    } catch (error) {
      const wrapped = translateKafkaError(error);
      this.logger?.warn("Failed to publish event envelope to Kafka", {
        eventId: envelope.id,
        runId: envelope.aggregateId,
        error: wrapped.message,
      });
      return err(wrapped);
    }
  }

  /**
   * Publishes a batch of canonical EventEnvelopes to Kafka in a single operation.
   * All envelopes are validated/serialized upfront before transmission.
   */
  async publishBatch(
    envelopes: readonly EventEnvelope[],
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (envelopes.length === 0) {
      return ok([]);
    }

    if (!this._connected) {
      return err(
        new KafkaNotConnectedError(
          "Kafka producer is not connected. Call connect() before publishing.",
        ),
      );
    }

    // Step 1: Pre-serialize all envelopes. Fail fast if any fails.
    const messages: { key: string; value: string; headers: Record<string, string> }[] = [];
    for (const env of envelopes) {
      const serResult = serializeEnvelope(env);
      if (!serResult.ok) {
        return serResult;
      }
      messages.push({
        key: env.aggregateId,
        value: serResult.value,
        headers: buildCloudEventsHeaders(env),
      });
    }

    // Step 2: Transmit batch to Kafka
    try {
      const recordMetas: RecordMetadata[] = await this.producer.send({
        topic: this.topic,
        messages,
      });

      const results: EventPublishResult[] = recordMetas.map((meta) => ({
        success: true,
        topic: meta.topicName,
        partition: meta.partition,
        offset: meta.offset,
        messageId: undefined,
      }));

      return ok(results);
    } catch (error) {
      const wrapped = translateKafkaError(error);
      this.logger?.warn("Failed to publish event batch to Kafka", {
        count: envelopes.length,
        error: wrapped.message,
      });
      return err(wrapped);
    }
  }
}
