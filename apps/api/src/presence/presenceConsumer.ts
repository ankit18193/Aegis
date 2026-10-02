import type { ITopicProvisioner, IWorkerRegistry } from "@aegis/contracts";
import { resolveWorkerAssignmentTopic } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Consumer } from "kafkajs";

import { deserializeWorkerHeartbeatEnvelope } from "./serialization.js";

export interface WorkerPresenceConsumerOptions {
  readonly consumer: Consumer;
  readonly registry: IWorkerRegistry;
  readonly topic?: string | undefined;
  readonly topicProvisioner?: ITopicProvisioner | undefined;
  readonly baseAssignmentTopic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * WorkerPresenceConsumer — Ingests worker heartbeats into the control-plane presence registry.
 *
 * Implements Phase 11E control-plane presence tracking:
 * 1. Dedicated consumer group: aegis-worker-presence
 * 2. Dedicated heartbeat topic: aegis.workers.heartbeat
 * 3. Updates control-plane IWorkerRegistry directly
 * 4. Fault-tolerant parsing: Malformed messages log warnings and don't halt consumer
 * 5. Explicit topic provisioning: Ensures dedicated assignment topic exists for newly registered workers
 */
export class WorkerPresenceConsumer {
  private readonly consumer: Consumer;
  private readonly registry: IWorkerRegistry;
  readonly topic: string;
  private readonly topicProvisioner?: ITopicProvisioner | undefined;
  private readonly baseAssignmentTopic: string;
  private readonly logger?: Logger | undefined;
  private isConnected = false;
  private _messagesProcessed = 0;

  constructor(options: WorkerPresenceConsumerOptions) {
    this.consumer = options.consumer;
    this.registry = options.registry;
    this.topic = options.topic ?? "aegis.workers.heartbeat";
    this.topicProvisioner = options.topicProvisioner;
    this.baseAssignmentTopic = options.baseAssignmentTopic ?? "aegis.tasks.assign";
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

    this.logger?.info("Starting control-plane WorkerPresenceConsumer", {
      topic: this.topic,
    });
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
    this.logger?.info("Control-plane WorkerPresenceConsumer connected and listening", {
      topic: this.topic,
    });
  }

  public async stop(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    this.logger?.info("Stopping control-plane WorkerPresenceConsumer", {
      topic: this.topic,
    });
    await this.consumer.disconnect();
    this.isConnected = false;
    this.logger?.info("Control-plane WorkerPresenceConsumer disconnected", {
      topic: this.topic,
    });
  }

  /**
   * Processes a single raw heartbeat message value.
   * Returns true if successfully updated registry, false if ignored/invalid.
   */
  public async handleMessage(
    raw: Buffer | string | null | undefined,
  ): Promise<boolean> {
    this._messagesProcessed++;

    const deserializeResult = deserializeWorkerHeartbeatEnvelope(raw);
    if (!deserializeResult.ok) {
      this.logger?.warn("Ignoring invalid or unparseable worker heartbeat message", {
        topic: this.topic,
        error: deserializeResult.error.message,
      });
      return false;
    }

    const envelope = deserializeResult.value;
    const heartbeat = envelope.data;

    // Check if worker was previously unknown to registry
    const wasKnown = this.registry.get(heartbeat.workerId) !== undefined;

    // Update in-memory registry
    this.registry.updateHeartbeat(heartbeat);

    // If new worker and provisioner configured, ensure dedicated assignment topic exists
    if (!wasKnown && this.topicProvisioner) {
      try {
        const dedicatedTopic = resolveWorkerAssignmentTopic(
          this.baseAssignmentTopic,
          heartbeat.workerId,
        );
        await this.topicProvisioner.ensureTopic(dedicatedTopic);
      } catch (err) {
        this.logger?.warn("Failed to provision dedicated assignment topic on worker discovery", {
          workerId: heartbeat.workerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return true;
  }
}
