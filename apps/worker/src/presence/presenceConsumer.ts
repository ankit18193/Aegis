import type { IWorkerRegistry } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Consumer } from "kafkajs";

import { deserializeWorkerHeartbeatEnvelope } from "../heartbeat/serialization.js";

export interface WorkerPresenceConsumerOptions {
  readonly consumer: Consumer;
  readonly registry: IWorkerRegistry;
  readonly topic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * WorkerPresenceConsumer — Ingests worker heartbeat events into the presence registry.
 *
 * Implements Phase 11D presence ingestion:
 * 1. Dedicated consumer group: aegis-worker-presence (LOCK 5)
 * 2. Dedicated topic: aegis.workers.heartbeat (LOCK 2)
 * 3. Idempotent state updates into IWorkerRegistry
 * 4. Fault-tolerant parsing: Malformed messages log warnings and commit offset (no poison loop)
 */
export class WorkerPresenceConsumer {
  private readonly consumer: Consumer;
  private readonly registry: IWorkerRegistry;
  readonly topic: string;
  private readonly logger?: Logger | undefined;
  private isConnected = false;
  private _messagesProcessed = 0;

  constructor(options: WorkerPresenceConsumerOptions) {
    this.consumer = options.consumer;
    this.registry = options.registry;
    this.topic = options.topic ?? "aegis.workers.heartbeat";
    this.logger = options.logger;
  }

  public get messagesProcessed(): number {
    return this._messagesProcessed;
  }

  public get running(): boolean {
    return this.isConnected;
  }

  public async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    this.logger?.info("Starting WorkerPresenceConsumer", { topic: this.topic });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ message, partition }) => {
        try {
          await this.handleMessage(message.value);
        } catch (err) {
          this.logger?.error("Unexpected error handling heartbeat message", {
            topic: this.topic,
            partition,
            offset: message.offset,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    this.isConnected = true;
    this.logger?.info("WorkerPresenceConsumer connected and listening", { topic: this.topic });
  }

  public async stop(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    this.logger?.info("Stopping WorkerPresenceConsumer", { topic: this.topic });
    await this.consumer.disconnect();
    this.isConnected = false;
    this.logger?.info("WorkerPresenceConsumer disconnected", { topic: this.topic });
  }

  /**
   * Processes a single raw heartbeat message value.
   * Returns true if successfully updated registry, false if ignored/invalid.
   */
  public handleMessage(raw: Buffer | string | null | undefined): Promise<boolean> {
    this._messagesProcessed++;

    const deserializeResult = deserializeWorkerHeartbeatEnvelope(raw);
    if (!deserializeResult.ok) {
      this.logger?.warn("Ignoring invalid or unparseable worker heartbeat message", {
        topic: this.topic,
        error: deserializeResult.error.message,
      });
      return Promise.resolve(false);
    }

    const envelope = deserializeResult.value;
    this.registry.updateHeartbeat(envelope.data);

    this.logger?.debug("Recorded worker presence update from Kafka heartbeat", {
      workerId: envelope.data.workerId,
      heartbeatId: envelope.data.heartbeatId,
      lifecycleState: envelope.data.lifecycleState,
    });

    return Promise.resolve(true);
  }
}
