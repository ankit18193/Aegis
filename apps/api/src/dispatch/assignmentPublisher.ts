import type {
  DispatchError,
  ITaskAssignmentPublisher,
  TaskAssignmentEnvelope,
} from "@aegis/contracts";
import { createDispatchError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Producer } from "kafkajs";

export interface KafkaTaskAssignmentPublisherOptions {
  readonly producer: Producer;
  readonly logger?: Logger | undefined;
}

/**
 * KafkaTaskAssignmentPublisher — Publishes task assignment envelopes to worker-targeted Kafka topics.
 *
 * Implements Lock 8 & Lock 9:
 * - Publishes strictly to dedicated worker-targeted topic (aegis.tasks.assign.${workerId})
 * - Uses taskId as partition key to ensure partition affinity
 * - Standard CloudEvents headers attached to Kafka message
 */
export class KafkaTaskAssignmentPublisher implements ITaskAssignmentPublisher {
  private readonly producer: Producer;
  private readonly logger?: Logger | undefined;
  private isConnected = false;

  constructor(options: KafkaTaskAssignmentPublisherOptions) {
    this.producer = options.producer;
    this.logger = options.logger;
  }

  public async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.producer.connect();
      this.isConnected = true;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.producer.disconnect();
      this.isConnected = false;
    }
  }

  public async publish(
    targetTopic: string,
    envelope: TaskAssignmentEnvelope,
  ): Promise<Result<TaskAssignmentEnvelope, DispatchError>> {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const serialized = JSON.stringify(envelope);

      await this.producer.send({
        topic: targetTopic,
        messages: [
          {
            key: envelope.data.taskId,
            value: serialized,
            headers: {
              "ce_id": envelope.id,
              "ce_type": envelope.type,
              "ce_source": envelope.source,
              "ce_time": envelope.time,
              "ce_specversion": envelope.specVersion,
              "ce_correlationid": envelope.correlationId,
              ...(envelope.causationId ? { "ce_causationid": envelope.causationId } : {}),
            },
          },
        ],
      });

      this.logger?.info("Dispatched task assignment to worker-targeted topic", {
        targetTopic,
        taskId: envelope.data.taskId,
        assignmentId: envelope.data.assignmentId,
        workerId: envelope.data.workerId,
      });

      return ok(envelope);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger?.error("Failed to publish task assignment to Kafka", {
        targetTopic,
        taskId: envelope.data.taskId,
        assignmentId: envelope.data.assignmentId,
        error: msg,
      });
      return err(
        createDispatchError(
          "DISPATCH_PUBLISH_FAILED",
          `Failed to publish task assignment to '${targetTopic}': ${msg}`,
          error,
        ),
      );
    }
  }
}

export interface PublishedRecord {
  readonly topic: string;
  readonly envelope: TaskAssignmentEnvelope;
}

/**
 * InMemoryTaskAssignmentPublisher — In-memory assignment publisher for hermetic unit & integration tests.
 */
export class InMemoryTaskAssignmentPublisher implements ITaskAssignmentPublisher {
  private readonly _published: PublishedRecord[] = [];
  public shouldFail = false;
  public failureMessage = "Simulated publish failure";

  public get published(): readonly PublishedRecord[] {
    return this._published;
  }

  public clear(): void {
    this._published.length = 0;
  }

  public publish(
    targetTopic: string,
    envelope: TaskAssignmentEnvelope,
  ): Promise<Result<TaskAssignmentEnvelope, DispatchError>> {
    if (this.shouldFail) {
      return Promise.resolve(
        err(
          createDispatchError(
            "DISPATCH_PUBLISH_FAILED",
            this.failureMessage,
          ),
        ),
      );
    }

    this._published.push({ topic: targetTopic, envelope });
    return Promise.resolve(ok(envelope));
  }
}
