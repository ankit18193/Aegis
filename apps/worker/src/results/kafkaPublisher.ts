import type {
  ITaskResultPublisher,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
} from "@aegis/contracts";
import { createTaskExecutionError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Producer } from "kafkajs";

import {
  createTaskResultEnvelope,
  serializeTaskResultEnvelope,
} from "./resultMapper.js";
import type { TaskResultPublishOptions } from "./types.js";

export interface KafkaTaskResultPublisherOptions {
  readonly producer: Producer;
  readonly topic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Kafka implementation of ITaskResultPublisher.
 * Publishes canonical TaskResultEnvelopes to aegis.tasks.results with taskId partitioning.
 */
export class KafkaTaskResultPublisher implements ITaskResultPublisher {
  private readonly producer: Producer;
  readonly topic: string;
  private readonly logger?: Logger | undefined;
  private isConnected = false;

  constructor(options: KafkaTaskResultPublisherOptions) {
    this.producer = options.producer;
    this.topic = options.topic ?? "aegis.tasks.results";
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    if (!this.isConnected) {
      await this.producer.connect();
      this.isConnected = true;
      this.logger?.info("KafkaTaskResultPublisher connected", { topic: this.topic });
    }
  }

  async stop(): Promise<void> {
    if (this.isConnected) {
      await this.producer.disconnect();
      this.isConnected = false;
      this.logger?.info("KafkaTaskResultPublisher disconnected");
    }
  }

  async publish(
    result: TaskExecutionResult,
    metadata?: TaskResultPublishOptions,
  ): Promise<Result<TaskResultEnvelope, TaskExecutionError>> {
    // 1. Create and validate canonical envelope
    let envelope: TaskResultEnvelope;
    try {
      envelope = createTaskResultEnvelope(result, metadata);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return err(
        createTaskExecutionError(
          "TASK_RESULT_SERIALIZATION_FAILED",
          `Invalid task result structure: ${msg}`,
        ),
      );
    }

    // 2. Serialize to payload string
    const serializeRes = serializeTaskResultEnvelope(envelope);
    if (!serializeRes.ok) {
      return err(serializeRes.error);
    }

    // 3. Publish to Kafka with taskId partitioning key and CloudEvents headers
    try {
      await this.producer.send({
        topic: this.topic,
        messages: [
          {
            key: result.taskId,
            value: serializeRes.value,
            headers: {
              "ce-id": envelope.id,
              "ce-type": envelope.type,
              "ce-source": envelope.source,
              "ce-time": envelope.time,
              "ce-correlationid": envelope.correlationId,
              ...(envelope.causationId ? { "ce-causationid": envelope.causationId } : {}),
            },
          },
        ],
      });

      this.logger?.debug("Task result published to Kafka", {
        topic: this.topic,
        taskId: result.taskId,
        status: result.status,
      });

      return ok(envelope);
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      this.logger?.error("Failed to publish task result to Kafka", {
        topic: this.topic,
        taskId: result.taskId,
        error: msg,
      });

      return err(
        createTaskExecutionError(
          "TASK_RESULT_PUBLICATION_FAILED",
          `Kafka publish failed for task ${result.taskId}: ${msg}`,
          error instanceof Error ? { name: error.name } : undefined,
        ),
      );
    }
  }
}
