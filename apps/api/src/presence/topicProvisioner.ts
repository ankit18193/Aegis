import type { DispatchError, ITopicProvisioner } from "@aegis/contracts";
import { createDispatchError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";
import type { Admin } from "kafkajs";

export interface KafkaTopicProvisionerOptions {
  readonly admin: Admin;
  readonly defaultPartitions?: number | undefined;
  readonly defaultReplicationFactor?: number | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * KafkaTopicProvisioner — Provisions worker-targeted Kafka topics using KafkaJS Admin client.
 *
 * Ensures dedicated topics (e.g. aegis.tasks.assign.worker-1) exist prior to message production
 * or consumption without relying on Kafka auto-creation.
 */
export class KafkaTopicProvisioner implements ITopicProvisioner {
  private readonly admin: Admin;
  private readonly defaultPartitions: number;
  private readonly defaultReplicationFactor: number;
  private readonly logger?: Logger | undefined;
  private isConnected = false;

  constructor(options: KafkaTopicProvisionerOptions) {
    this.admin = options.admin;
    this.defaultPartitions = options.defaultPartitions ?? 1;
    this.defaultReplicationFactor = options.defaultReplicationFactor ?? 1;
    this.logger = options.logger;
  }

  public async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.admin.connect();
      this.isConnected = true;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.admin.disconnect();
      this.isConnected = false;
    }
  }

  public async ensureTopic(
    topic: string,
    partitions?: number,
    replicationFactor?: number,
  ): Promise<Result<boolean, DispatchError>> {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      const existingTopics = await this.admin.listTopics();
      if (existingTopics.includes(topic)) {
        return ok(false); // Already exists
      }

      this.logger?.info("Provisioning dedicated worker assignment topic", { topic });
      const created = await this.admin.createTopics({
        topics: [
          {
            topic,
            numPartitions: partitions ?? this.defaultPartitions,
            replicationFactor: replicationFactor ?? this.defaultReplicationFactor,
          },
        ],
      });

      return ok(created);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger?.error("Failed to provision topic", { topic, error: msg });
      return err(
        createDispatchError(
          "TOPIC_PROVISION_FAILED",
          `Failed to ensure topic '${topic}': ${msg}`,
          error,
        ),
      );
    }
  }
}

/**
 * InMemoryTopicProvisioner — In-memory topic provisioner for unit and integration testing.
 */
export class InMemoryTopicProvisioner implements ITopicProvisioner {
  private readonly topics = new Set<string>();

  constructor(initialTopics: string[] = []) {
    for (const t of initialTopics) {
      this.topics.add(t);
    }
  }

  public get provisionedTopics(): string[] {
    return Array.from(this.topics);
  }

  public hasTopic(topic: string): boolean {
    return this.topics.has(topic);
  }

  public ensureTopic(topic: string): Promise<Result<boolean, DispatchError>> {
    if (this.topics.has(topic)) {
      return Promise.resolve(ok(false));
    }
    this.topics.add(topic);
    return Promise.resolve(ok(true));
  }
}
