import type {
  IWorkerHeartbeatPublisher,
  WorkerHeartbeat,
  WorkerHeartbeatEnvelope,
  WorkerHeartbeatError,
} from "@aegis/contracts";
import {
  createWorkerHeartbeatError,
  workerHeartbeatEnvelopeSchema,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Producer } from "kafkajs";

import { serializeWorkerHeartbeatEnvelope } from "./serialization.js";

export interface KafkaWorkerHeartbeatPublisherOptions {
  readonly producer: Producer;
  readonly topic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * KafkaWorkerHeartbeatPublisher — Emits worker heartbeats to Kafka.
 *
 * Implements Phase 11D transport invariants:
 * 1. Dedicated heartbeat topic: aegis.workers.heartbeat (LOCK 2)
 * 2. Keyed strictly by workerId for FIFO partition ordering (LOCK 4)
 * 3. Enforces CloudEvents v1.0 standard headers
 * 4. Fault-tolerant error mapping to WorkerHeartbeatError
 */
export class KafkaWorkerHeartbeatPublisher implements IWorkerHeartbeatPublisher {
  private readonly producer: Producer;
  readonly topic: string;
  private readonly logger?: Logger | undefined;
  private isConnected = false;

  constructor(options: KafkaWorkerHeartbeatPublisherOptions) {
    this.producer = options.producer;
    this.topic = options.topic ?? "aegis.workers.heartbeat";
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    if (!this.isConnected) {
      await this.producer.connect();
      this.isConnected = true;
      this.logger?.info("KafkaWorkerHeartbeatPublisher connected", { topic: this.topic });
    }
  }

  public async stop(): Promise<void> {
    if (this.isConnected) {
      await this.producer.disconnect();
      this.isConnected = false;
      this.logger?.info("KafkaWorkerHeartbeatPublisher disconnected");
    }
  }

  public async publish(
    heartbeat: WorkerHeartbeat,
    metadata?: { readonly correlationId?: string | undefined; readonly causationId?: string | undefined },
  ): Promise<Result<WorkerHeartbeatEnvelope, WorkerHeartbeatError>> {
    // 1. Construct canonical CloudEvent envelope
    const envelope: WorkerHeartbeatEnvelope = {
      id: heartbeat.heartbeatId,
      type: "worker_heartbeat",
      source: `aegis.worker.${heartbeat.workerId}`,
      specVersion: "1.0",
      time: heartbeat.occurredAt,
      aggregateId: heartbeat.workerId,
      aggregateType: "Worker",
      correlationId: metadata?.correlationId ?? `corr-hb-${heartbeat.heartbeatId}`,
      causationId: metadata?.causationId,
      data: heartbeat,
    };

    // 2. Validate envelope against schema
    const parseResult = workerHeartbeatEnvelopeSchema.safeParse(envelope);
    if (!parseResult.success) {
      return err(
        createWorkerHeartbeatError(
          "INVALID_HEARTBEAT_ENVELOPE",
          `Invalid worker heartbeat envelope: ${parseResult.error.message}`,
          parseResult.error,
        ),
      );
    }

    // 3. Serialize to JSON payload
    const serializeResult = serializeWorkerHeartbeatEnvelope(envelope);
    if (!serializeResult.ok) {
      return err(serializeResult.error);
    }

    // 4. Send to Kafka partitioned by workerId (LOCK 4)
    try {
      await this.producer.send({
        topic: this.topic,
        messages: [
          {
            key: heartbeat.workerId,
            value: serializeResult.value,
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

      this.logger?.debug("Worker heartbeat published to Kafka", {
        topic: this.topic,
        workerId: heartbeat.workerId,
        heartbeatId: heartbeat.heartbeatId,
        lifecycleState: heartbeat.lifecycleState,
      });

      return ok(envelope);
    } catch (sendError) {
      const msg = sendError instanceof Error ? sendError.message : String(sendError);
      this.logger?.warn("Failed to publish worker heartbeat to Kafka", {
        topic: this.topic,
        workerId: heartbeat.workerId,
        heartbeatId: heartbeat.heartbeatId,
        error: msg,
      });

      return err(
        createWorkerHeartbeatError(
          "HEARTBEAT_PUBLICATION_FAILED",
          `Kafka publish failed for worker heartbeat ${heartbeat.heartbeatId}: ${msg}`,
          sendError,
        ),
      );
    }
  }
}
